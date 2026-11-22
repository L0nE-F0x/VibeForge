import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { readJson, readText, writeFileAtomic, writeJson } from "../fsx.js";
import type { OrchestratorThreadSummary, OrchestratorTurn } from "../orchestrator.js";
import { isSafeId } from "../slug.js";
import type { ServiceCore } from "./core.js";
import { oneLine } from "./orchestrator-utils.js";
import type { Deleted } from "./types.js";

const MEMORY_LIMIT = 8000;
const MAX_THREADS = 50;
const MAX_VERIFY_OUTPUT = 16 * 1024;
const KILL_GRACE_MS = 2000;
export const MAX_IMAGES_PER_TURN = 4;
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const SAFE_IMAGE_NAME = /^img-[a-z0-9-]+\.(png|jpg|webp|gif)$/;

export interface SavedPromptImage {
  filename: string;
  path: string;
  mediaType: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
  base64: string;
}

const IMAGE_DATA_URL_RE = /^data:image\/(?:png|jpeg|jpg|webp|gif);base64,([A-Za-z0-9+/=\s]+)$/i;

function detectImageFormat(buf: Buffer): { ext: "png" | "jpg" | "webp" | "gif"; mediaType: SavedPromptImage["mediaType"] } | null {
  if (
    buf.length >= 8 &&
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47 &&
    buf[4] === 0x0d &&
    buf[5] === 0x0a &&
    buf[6] === 0x1a &&
    buf[7] === 0x0a
  ) {
    return { ext: "png", mediaType: "image/png" };
  }
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return { ext: "jpg", mediaType: "image/jpeg" };
  }
  if (buf.length >= 6 && buf.subarray(0, 4).toString("ascii") === "GIF8") {
    return { ext: "gif", mediaType: "image/gif" };
  }
  if (buf.length >= 12 && buf.subarray(0, 4).toString("ascii") === "RIFF" && buf.subarray(8, 12).toString("ascii") === "WEBP") {
    return { ext: "webp", mediaType: "image/webp" };
  }
  return null;
}

function mediaTypeForExt(name: string): SavedPromptImage["mediaType"] | null {
  if (name.endsWith(".png")) return "image/png";
  if (name.endsWith(".jpg")) return "image/jpeg";
  if (name.endsWith(".webp")) return "image/webp";
  if (name.endsWith(".gif")) return "image/gif";
  return null;
}

/** Validate up to 4 pasted/dropped image data URLs (PNG/JPEG/WebP/GIF, <=10 MB each) and save to disk. */
export function savePastedImages(imagesDir: string, rawImages: ReadonlyArray<string> | undefined): SavedPromptImage[] {
  if (!rawImages?.length) return [];
  const entries: Array<{ buf: Buffer; base64: string; ext: "png" | "jpg" | "webp" | "gif"; mediaType: SavedPromptImage["mediaType"] }> = [];
  for (const raw of rawImages.slice(0, MAX_IMAGES_PER_TURN)) {
    const match = typeof raw === "string" ? IMAGE_DATA_URL_RE.exec(raw.trim()) : null;
    if (!match) throw new Error("Unsupported image format.");
    const cleanB64 = match[1].replace(/\s+/g, "");
    const padding = cleanB64.endsWith("==") ? 2 : cleanB64.endsWith("=") ? 1 : 0;
    const approxBytes = Math.floor((cleanB64.length * 3) / 4) - padding;
    if (approxBytes > MAX_IMAGE_BYTES) throw new Error("That image is larger than 10 MB.");
    const buf = Buffer.from(cleanB64, "base64");
    if (!buf.length) throw new Error("Unsupported image format.");
    if (buf.length > MAX_IMAGE_BYTES) throw new Error("That image is larger than 10 MB.");
    const fmt = detectImageFormat(buf);
    if (!fmt) throw new Error("Unsupported image format.");
    entries.push({ buf, base64: buf.toString("base64"), ...fmt });
  }
  fs.mkdirSync(imagesDir, { recursive: true });
  return entries.map((entry) => {
    const filename = `img-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}.${entry.ext}`;
    const fullPath = path.join(imagesDir, filename);
    fs.writeFileSync(fullPath, entry.buf);
    return { filename, path: fullPath, mediaType: entry.mediaType, base64: entry.base64 };
  });
}

/** Read a saved turn image as base64 + mediaType, rejecting any unsafe filename. */
export function readSavedImageBase64(imagesDir: string, name: string): { mediaType: SavedPromptImage["mediaType"]; base64: string } | null {
  if (!SAFE_IMAGE_NAME.test(name)) return null;
  const fallbackMime = mediaTypeForExt(name);
  if (!fallbackMime) return null;
  try {
    const buf = fs.readFileSync(path.join(imagesDir, name));
    if (!buf.length) return null;
    const detected = detectImageFormat(buf);
    return { mediaType: detected?.mediaType ?? fallbackMime, base64: buf.toString("base64") };
  } catch {
    return null;
  }
}

/** Read a saved turn image as a data URL for desktop UI thumbnails and lightbox previews. */
export function readSavedImageDataUrl(imagesDir: string, name: string): string | null {
  const image = readSavedImageBase64(imagesDir, name);
  return image ? `data:${image.mediaType};base64,${image.base64}` : null;
}

export interface SavedConversation {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  sessionId: string;
  engineId: string;
  begun: boolean;
  initialRules?: string;
  workspacesKey?: string;
  liveKey?: string;
  settingsKey?: string;
  libraryKey?: string;
  memoryKey?: string;
  turns: OrchestratorTurn[];
}

export interface VerifyRunResult {
  code: number | null;
  output: string;
  timedOut: boolean;
}

export type VerifyRunner = (command: string, cwd: string, signal: AbortSignal, timeoutMs: number, env: NodeJS.ProcessEnv) => Promise<VerifyRunResult>;

export function vibyMemoryFile(configRoot: string): string {
  return path.join(configRoot, "viby.md");
}

export function readVibyMemory(configRoot: string): string {
  return readText(vibyMemoryFile(configRoot));
}

export function boundedVibyMemory(configRoot: string): string {
  return readVibyMemory(configRoot).trim().slice(0, MEMORY_LIMIT);
}

export function writeVibyMemory(configRoot: string, text: string): void {
  const file = vibyMemoryFile(configRoot);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeFileAtomic(file, text);
}

export function deriveThreadTitle(turns: readonly OrchestratorTurn[]): string {
  const firstUser = turns.find((turn) => turn.from === "you" && turn.text.trim());
  if (firstUser) return oneLine(firstUser.text, 56);
  const firstViby = turns.find((turn) => turn.text.trim());
  return firstViby ? oneLine(firstViby.text, 56) : "New conversation";
}

function threadPath(threadsDir: string, id: string): string {
  if (!isSafeId(id)) throw new Error("Invalid thread id.");
  return path.join(threadsDir, `${id}.json`);
}

function summarizeSaved(conv: SavedConversation): OrchestratorThreadSummary {
  const turns = conv.turns;
  const last = [...turns].reverse().find((turn) => turn.text.trim() || turn.note);
  const preview = last?.text.trim() ? oneLine(last.text, 90) : last?.note ? `${last.note.engine} · ${last.note.workspace}` : "";
  return {
    id: conv.id,
    title: conv.title || deriveThreadTitle(turns),
    createdAt: conv.createdAt,
    updatedAt: conv.updatedAt,
    turnCount: turns.length,
    preview,
  };
}

export function saveThreadSnapshot(threadsDir: string, conv: SavedConversation): void {
  if (!conv.turns.length) return;
  fs.mkdirSync(threadsDir, { recursive: true });
  const title = conv.title || deriveThreadTitle(conv.turns);
  const updatedAt = conv.turns.at(-1)?.at || conv.updatedAt;
  writeJson(threadPath(threadsDir, conv.id), { ...conv, title, updatedAt });
  pruneThreads(threadsDir);
}

function pruneThreads(threadsDir: string): void {
  let entries: string[];
  try {
    entries = fs.readdirSync(threadsDir).filter((name) => name.endsWith(".json"));
  } catch {
    return;
  }
  if (entries.length <= MAX_THREADS) return;
  const withTime = entries
    .map((name) => {
      const full = path.join(threadsDir, name);
      const saved = readJson<Partial<SavedConversation> | null>(full, null);
      return { full, updatedAt: typeof saved?.updatedAt === "string" ? saved.updatedAt : "" };
    })
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  for (const old of withTime.slice(MAX_THREADS)) {
    fs.rmSync(old.full, { force: true });
  }
}

export function listThreadSummaries(threadsDir: string, activeConv: SavedConversation): OrchestratorThreadSummary[] {
  const map = new Map<string, OrchestratorThreadSummary>();
  try {
    for (const name of fs.readdirSync(threadsDir)) {
      if (!name.endsWith(".json")) continue;
      const saved = readJson<Partial<SavedConversation> | null>(path.join(threadsDir, name), null);
      if (!saved || typeof saved.id !== "string" || !Array.isArray(saved.turns) || !saved.turns.length) continue;
      map.set(saved.id, summarizeSaved(saved as SavedConversation));
    }
  } catch {
    /* threads dir does not exist yet */
  }
  if (activeConv.turns.length) {
    map.set(activeConv.id, summarizeSaved(activeConv));
  }
  return [...map.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function loadSavedThread(threadsDir: string, id: string): SavedConversation {
  const saved = readJson<Partial<SavedConversation> | null>(threadPath(threadsDir, id), null);
  if (!saved || typeof saved.id !== "string" || !Array.isArray(saved.turns)) {
    throw new Error("That conversation is gone.");
  }
  for (const turn of saved.turns) {
    if (turn.plan === "running") turn.plan = "done";
    for (const step of turn.steps ?? []) if (step.state === "running") step.state = "failed";
  }
  return {
    id: saved.id,
    title: typeof saved.title === "string" && saved.title ? saved.title : deriveThreadTitle(saved.turns),
    createdAt: typeof saved.createdAt === "string" ? saved.createdAt : new Date().toISOString(),
    updatedAt: typeof saved.updatedAt === "string" ? saved.updatedAt : new Date().toISOString(),
    sessionId: typeof saved.sessionId === "string" && saved.sessionId ? saved.sessionId : randomUUID(),
    engineId: typeof saved.engineId === "string" ? saved.engineId : "",
    begun: Boolean(saved.begun),
    ...(typeof saved.initialRules === "string" && saved.initialRules ? { initialRules: saved.initialRules } : {}),
    ...(typeof saved.workspacesKey === "string" ? { workspacesKey: saved.workspacesKey } : {}),
    ...(typeof saved.liveKey === "string" ? { liveKey: saved.liveKey } : {}),
    ...(typeof saved.settingsKey === "string" ? { settingsKey: saved.settingsKey } : {}),
    ...(typeof saved.libraryKey === "string" ? { libraryKey: saved.libraryKey } : {}),
    ...(typeof saved.memoryKey === "string" ? { memoryKey: saved.memoryKey } : {}),
    turns: saved.turns,
  };
}

export function renameSavedThread(threadsDir: string, id: string, title: string, activeConv: SavedConversation): boolean {
  const clean = oneLine(title, 80);
  if (!clean) throw new Error("Give the conversation a title.");
  if (activeConv.id === id) {
    activeConv.title = clean;
    if (activeConv.turns.length) saveThreadSnapshot(threadsDir, activeConv);
    return true;
  }
  const loaded = loadSavedThread(threadsDir, id);
  loaded.title = clean;
  writeJson(threadPath(threadsDir, id), loaded);
  return false;
}

export function deleteSavedThread(core: ServiceCore, threadsDir: string, id: string, onAfterChange: () => void): Deleted {
  const file = threadPath(threadsDir, id);
  if (!fs.existsSync(file)) throw new Error("That conversation is gone.");
  const bin = core.trash.stash([file]);
  onAfterChange();
  return core.keepForUndo(bin, () => onAfterChange());
}

/** Runs a verification shell command in `cwd` inside its own process group, bounded by timeout & abort signal. */
export const spawnVerifyCommand: VerifyRunner = (command, cwd, signal, timeoutMs, env) =>
  new Promise((resolve) => {
    const child = spawn("/bin/sh", ["-c", command], { cwd, env, stdio: ["ignore", "pipe", "pipe"], detached: true });
    let output = "";
    let timedOut = false;
    let finished = false;
    let killTimer: NodeJS.Timeout | null = null;
    const group = (sig: NodeJS.Signals) => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, sig);
      } catch {
        /* already gone */
      }
    };
    const append = (chunk: string) => {
      output = (output + chunk).slice(-MAX_VERIFY_OUTPUT);
    };
    const done = (code: number | null) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      signal.removeEventListener("abort", stop);
      resolve({ code, output: output.trim(), timedOut });
    };
    const stop = () => {
      if (finished || killTimer) return;
      group("SIGTERM");
      killTimer = setTimeout(() => {
        group("SIGKILL");
        killTimer = setTimeout(() => done(null), KILL_GRACE_MS);
      }, KILL_GRACE_MS);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, timeoutMs);
    if (signal.aborted) stop();
    else signal.addEventListener("abort", stop, { once: true });
    child.stdout?.setEncoding("utf8").on("data", append);
    child.stderr?.setEncoding("utf8").on("data", append);
    child.on("error", (err) => {
      append(err.message);
      done(127);
    });
    child.on("close", done);
  });
