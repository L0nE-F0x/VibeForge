import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runGit } from "../git.js";
import type { OrchestratorStep, PlanContext } from "../orchestrator.js";
import type { ApplyResult } from "../worktrees.js";

/** The size a terminal starts at before its pane in Code resizes it. */
export const START_SIZE = { cols: 120, rows: 32 };
/** Folders on disk a lookup names at most, and how long it may look for them. */
export const LOOKUP_FOLDERS = 8;
export const LOOKUP_WALK_MS = 3000;

export function expandHome(folder: string): string {
  return folder === "~" ? os.homedir() : folder.startsWith("~/") ? path.join(os.homedir(), folder.slice(2)) : folder;
}

export function isInside(parent: string, child: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/** Resolve symlinks on both paths so a symlink inside `parent` cannot escape outside it. */
export function realInside(parent: string, child: string): string | null {
  try {
    const realParent = fs.realpathSync(parent);
    const realChild = fs.realpathSync(child);
    return isInside(realParent, realChild) ? realChild : null;
  } catch {
    return null;
  }
}

export function oneLine(text: string, max: number): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}

export function gitIn(args: string[], cwd: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return runGit(args, { cwd, timeoutMs: 5000, maxBuffer: 4 * 1024 * 1024 });
}

/** A repository with at least one commit, which a copy can be made from. */
export async function hasCommit(folder: string): Promise<boolean> {
  return (await gitIn(["rev-parse", "--verify", "-q", "HEAD"], folder)).code === 0;
}

/** A task or routine step that is waiting for its folder (core.orchWaitsTurn). */
export function waitsTurn(behind: readonly string[]): string {
  return `Waiting for ${behind.join(", ") || "another CLI"} in that folder; it starts on its own once it's quiet.`;
}

/** Files changed and not committed in a repository (new ones included); 0 when git can't say. */
export async function uncommitted(folder: string): Promise<number> {
  const status = await gitIn(["status", "--porcelain", "--untracked-files=normal"], folder);
  return status.code === 0 ? status.stdout.split("\n").filter(Boolean).length : 0;
}

export function tildify(folder: string): string {
  const home = os.homedir();
  return folder === home || folder.startsWith(`${home}/`) ? `~${folder.slice(home.length)}` : folder;
}

/** Replace a planned placeholder id (`new:<stepId>`) across all later steps in the same turn. */
export function substitutePlannedId(
  steps: OrchestratorStep[] | undefined,
  placeholder: string,
  realId: string,
  extraPath?: string,
): void {
  if (!steps) return;
  for (const later of steps) {
    if (later.workspaceId === placeholder) later.workspaceId = realId;
    if (later.target === placeholder) later.target = realId;
    if (later.agentId === placeholder) later.agentId = realId;
    if (later.taskId === placeholder) later.taskId = realId;
    if (later.places?.includes(placeholder)) {
      later.places = later.places.map((p) => (p === placeholder ? (extraPath ?? realId) : p));
    }
    if (later.skills?.includes(placeholder)) {
      later.skills = later.skills.map((s) => (s === placeholder ? realId : s));
    }
    if (later.agents?.includes(placeholder)) {
      later.agents = later.agents.map((a) => (a === placeholder ? realId : a));
    }
    if (later.route) {
      let changed = false;
      const nextRoute: Record<string, string> = {};
      for (const [key, val] of Object.entries(later.route)) {
        if (val === placeholder) {
          nextRoute[key] = realId;
          changed = true;
        } else {
          nextRoute[key] = val;
        }
      }
      if (changed) later.route = nextRoute;
    }
  }
}

export function formatApplyResult(result: ApplyResult, cleanLabel: string): string {
  if (result.conflicts.length) {
    return `Applied with conflicts to sort out in ${result.conflicts.slice(0, 5).join(", ")}${result.conflicts.length > 5 ? "…" : ""}. The copy stays until they are.`;
  }
  if (result.pulled) {
    const { branch, upstream, alreadyUpToDate } = result.pulled;
    const head = alreadyUpToDate ? `Already merged in ${branch}.` : `Already merged on ${upstream}; fast-forwarded ${branch}.`;
    if (result.left) {
      return `${head} Ignored files stay in the copy (${result.left.files.slice(0, 5).join(", ")}${result.left.files.length > 5 ? "…" : ""}) at ${result.left.folder} until discarded.`;
    }
    return `${head} The copy is gone.`;
  }
  if (result.left) {
    return `Applied as uncommitted changes. Ignored files stay in the copy (${result.left.files.slice(0, 5).join(", ")}${result.left.files.length > 5 ? "…" : ""}) at ${result.left.folder} until discarded.`;
  }
  return cleanLabel;
}

/** Compact fingerprint of workspaces, live sessions, and review copies so cached planners hear deltas. */
export function liveStateFingerprint(context: PlanContext): string {
  return JSON.stringify([
    context.workspaces.map((w) => `${w.id}:${w.name}:${w.folder}:${w.git}`),
    context.running.map((r) => `${r.id}:${r.engine}:${r.workspace}:${r.working ? 1 : 0}:${r.waiting ?? ""}:${r.branch ?? ""}:${r.asked ?? ""}`),
    (context.copies ?? []).map((c) => `${c.id}:${c.name}:${c.branch}:${c.workspace}`),
  ]);
}

export function formatLiveUpdate(context: PlanContext): string {
  const workspaces = context.workspaces.length ? context.workspaces.map((w) => `${w.name} (${w.folder})`).join(", ") : "none";
  const running = context.running.length
    ? context.running
        .map(
          (r) =>
            `${r.id} (${r.engine} in ${r.workspace}, ${r.working ? "working" : r.waiting ? `WAITING ON PROMPT: "${r.waiting}"` : "waiting"}${r.branch ? `, ${r.branch}` : ""}${r.asked ? `; asked: ${r.asked}` : ""})`,
        )
        .join("; ")
    : "none";
  const copies = context.copies?.length ? context.copies.map((c) => `${c.id} (${c.name}, ${c.branch} from ${c.workspace})`).join(", ") : "none";
  return `(Updated live state:\n- Workspaces: ${workspaces}\n- Running: ${running}\n- Copies waiting for review: ${copies})`;
}

/** Compact fingerprint of saved library items so a resumed planner notices changes between turns. */
export function libraryFingerprint(context: PlanContext): string {
  return JSON.stringify([
    (context.agents ?? []).map((a) => `${a.id}:${a.name}:${a.engine}:${(a.places ?? []).length}:${(a.skills ?? []).join(",")}:${a.allowRoutines ?? true}`),
    (context.skills ?? []).map((s) => `${s.id}:${s.name}:${(s.agents ?? []).join(",")}`),
    (context.routines ?? []).map((r) => `${r.id}:${r.name}:${r.schedule}:${r.enabled}:${r.agentId ?? ""}`),
    (context.tasks ?? []).map((t) => `${t.id}:${t.title}:${t.status}:${t.agentId ?? ""}:${t.workspaceId ?? ""}:${t.hasCopy ?? false}`),
    (context.chats ?? []).map((c) => `${c.id}:${c.title}:${c.engine}:${c.agentId ?? ""}`),
  ]);
}

export function formatLibraryUpdate(context: PlanContext): string {
  const lines: string[] = [];
  lines.push(
    context.agents?.length
      ? `- Agents: ${context.agents.map((a) => `${a.id} ("${a.name}", ${a.engine})`).join(", ")}`
      : "- Agents: none",
  );
  if (context.skills?.length) {
    lines.push(`- Skills: ${context.skills.map((s) => `${s.id} ("${s.name}")`).join(", ")}`);
  }
  if (context.routines?.length) {
    lines.push(`- Routines: ${context.routines.map((r) => `${r.id} ("${r.name}", ${r.schedule}, ${r.enabled ? "on" : "paused"})`).join(", ")}`);
  }
  if (context.tasks?.length) {
    lines.push(`- Tasks: ${context.tasks.map((t) => `${t.id} ("${t.title}", ${t.status})`).join(", ")}`);
  }
  if (context.chats?.length) {
    lines.push(`- Chats: ${context.chats.map((c) => `${c.id} ("${c.title}")`).join(", ")}`);
  }
  return `(Updated library state:\n${lines.join("\n")})`;
}

export function memoryFingerprint(memory: string): string {
  return createHash("sha256").update(memory).digest("hex").slice(0, 12);
}

export function formatMemoryUpdate(memory: string): string {
  return `(Updated Viby memory (~/.config/vibeforge/viby.md):\n${memory.trim() || "(empty)"})`;
}

/** Parse optional `:start[-end]` or `#Lstart[-Lend]` line-range suffix from an inspect file path. */
export function parseFileAndRange(raw: string): { file: string; range?: { start: number; end: number } } {
  const trimmed = raw.trim();
  const hashMatch = /^(.+?)#L(\d+)(?:-L?(\d+))?$/i.exec(trimmed);
  if (hashMatch) {
    const start = Math.max(1, Number(hashMatch[2]));
    const end = Math.max(start, Number(hashMatch[3] ?? hashMatch[2]));
    return { file: hashMatch[1].trim(), range: { start, end: Math.min(end, start + 240) } };
  }
  const colonMatch = /^(.+?):(\d+)(?:-(\d+))?$/.exec(trimmed);
  if (colonMatch) {
    const start = Math.max(1, Number(colonMatch[2]));
    const end = Math.max(start, Number(colonMatch[3] ?? colonMatch[2]));
    return { file: colonMatch[1].trim(), range: { start, end: Math.min(end, start + 240) } };
  }
  return { file: trimmed };
}

const SENSITIVE_INSPECT_DIRS = new Set([".ssh", ".gnupg", ".aws", ".kube", ".docker"]);
const SAFE_ENV_SAMPLES = /^\.env\.(?:example|sample|template)$/i;

export function isSensitiveInspectPath(rel: string): boolean {
  const parts = rel.split("/").filter(Boolean);
  if (parts.some((part) => SENSITIVE_INSPECT_DIRS.has(part))) return true;
  const base = (parts.at(-1) ?? "").toLowerCase();
  if (!base) return false;
  if (/^\.env(?:\..+)?$/.test(base) && !SAFE_ENV_SAMPLES.test(base)) return true;
  if (/^\.(?:npmrc|netrc|pypirc|git-credentials|dockercfg)$/.test(base)) return true;
  if (/\.(?:pem|key|p12|pfx|keystore|jks|kdbx)$/.test(base)) return true;
  return /^(?:id_(?:rsa|dsa|ecdsa|ed25519)(?:\..*)?|authorized_keys|known_hosts|credentials(?:\.json)?)$/.test(base);
}

export function readBoundedInspectText(fullPath: string, range?: { start: number; end: number }): { text: string } | { reason: string } | null {
  let fd: number;
  try {
    fd = fs.openSync(fullPath, fs.constants.O_RDONLY);
  } catch {
    return null;
  }
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) return null;
    const cap = Math.min(stat.size, range ? 128 * 1024 : 16 * 1024);
    const buf = Buffer.allocUnsafe(cap);
    let offset = 0;
    while (offset < cap) {
      const read = fs.readSync(fd, buf, offset, cap - offset, offset);
      if (read <= 0) break;
      offset += read;
    }
    const slice = buf.subarray(0, offset);
    if (slice.includes(0)) return { reason: "binary file" };
    const text = slice.toString("utf8");
    if (!range) return { text: text.slice(0, 8000) };
    const lines = text.split(/\r?\n/);
    const start = Math.max(1, range.start);
    const end = Math.min(lines.length, range.end);
    if (start > lines.length) return { text: `(File has ${lines.length} lines; requested line ${start}.)` };
    const numbered = lines
      .slice(start - 1, end)
      .map((line, i) => `L${start + i}: ${line}`)
      .join("\n");
    return { text: numbered.slice(0, 8000) };
  } catch {
    return null;
  } finally {
    fs.closeSync(fd);
  }
}
