import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { bearerToken, tokenMatches, type DeskPayload } from "./companion.js";
import type { PhoneOrchestrator } from "./companion-orchestrator.js";
import { phoneCoreText, phoneLanguage, phoneSay, phoneWords, type PhoneLanguage } from "./companion-text.js";
import type { OrchestratorStep } from "./orchestrator.js";
import type { PlanSummary } from "./plans.js";
import { BYTES_PER_SECOND, MAX_SECONDS } from "./voice.js";
import type { en } from "../ui/i18n/en.js";

type PhoneKey = Extract<keyof typeof en, `phone.${string}`>;

/** A prompt the phone may send. Longer than this is a paste, not a nudge. */
export const COMPANION_PROMPT_MAX = 8000;

const BODY_MAX = 64_000;

/** Speech from the phone: 16 kHz mono s16le, as long as a recording on the computer may be. */
export const HEAR_MAX = MAX_SECONDS * BYTES_PER_SECOND;

/** A recording that ran a moment past the cap is cut to it; one this long is not speech. */
export const HEAR_READ_MAX = HEAR_MAX + 10 * BYTES_PER_SECOND;

export interface SessionPayload {
  ptyId: string | null;
  runId: string | null;
  title: string;
  detail: string;
  state: "working" | "waiting" | "done";
  changes: string | null;
  screen: string;
  /** False when nothing can pick this up: the session ended and left no run behind. */
  canSend: boolean;
  /** "end" closes a run's own terminal; "interrupt" stops a CLI's turn in a shell and leaves the shell open. */
  stop: "end" | "interrupt" | null;
}

export interface LaunchResult {
  ptyId: string;
  runId: string;
}

export interface CompanionActions {
  desk(): DeskPayload;
  session(query: { ptyId: string; runId: string }): Promise<SessionPayload>;
  /**
   * The next instruction. A live CLI gets it typed in (`working` means refused until the phone asks
   * again); a finished one is picked back up with it. It never lands in a shell with no CLI.
   */
  send(input: { ptyId: string; runId: string; text: string; force: boolean }): Promise<{ working: true } | ({ working: false } & LaunchResult)>;
  stop(ptyId: string): Promise<void>;
  /** Start an agent, or a CLI on its own, in a workspace. */
  launch(input: { workspaceId: string; agentId: string; engineId: string; prompt: string }): Promise<LaunchResult>;
  /** Plan limits as the desktop shows them, or null when Settings leave them off. */
  plans(): Promise<PlanSummary | null>;
  /** The Orchestrator: the computer's own conversation and plans. The phone shows them and asks. */
  orchestrator: OrchestratorActions;
  /** Speech from the phone's mic (16 kHz mono s16le), turned into words by the computer's whisper. */
  hear(pcm: Buffer): Promise<{ text: string; empty: "short" | "silent" | "nothing" | null }>;
}

export type StepPatch = Partial<Pick<OrchestratorStep, "engineId" | "workspaceId" | "branch" | "prompt" | "target">>;

/** What the desktop's Orchestrator view does, for the phone. */
export interface OrchestratorActions {
  view(): PhoneOrchestrator;
  /** Starts a planning turn and returns; the answer comes as a later turn. Refused while one is still answering. */
  ask(text: string): void;
  stopThinking(): void;
  /** New: an empty conversation and a new session for the planner. Running CLIs keep running. */
  clear(): void;
  /** Go. */
  run(turnId: string): Promise<void>;
  cancel(turnId: string): void;
  editStep(turnId: string, stepId: string, patch: StepPatch): void;
  removeStep(turnId: string, stepId: string): void;
  /** The view's own header: which CLI plans, and whether a plan waits for Go. */
  settings(patch: { engine?: string; mode?: "plan" | "go" }): void;
}

/** A refusal the phone shows: a `phone.*` sentence, sent in the phone's language. */
export class CompanionHttpError extends Error {
  constructor(
    readonly key: PhoneKey,
    readonly status: number,
    readonly extra?: Record<string, unknown>,
  ) {
    super(key);
  }
}

const PAGES: Record<string, { name: string; type: string }> = {
  "/": { name: "index.html", type: "text/html; charset=utf-8" },
  "/index.html": { name: "index.html", type: "text/html; charset=utf-8" },
  "/app.css": { name: "app.css", type: "text/css; charset=utf-8" },
  "/app.js": { name: "app.js", type: "text/javascript; charset=utf-8" },
  "/sw.js": { name: "sw.js", type: "text/javascript; charset=utf-8" },
  "/mic-worklet.js": { name: "mic-worklet.js", type: "text/javascript; charset=utf-8" },
  "/manifest.webmanifest": { name: "manifest.webmanifest", type: "application/manifest+json" },
  "/fonts/geist-latin-wght-normal.woff2": { name: "fonts/geist-latin-wght-normal.woff2", type: "font/woff2" },
  "/fonts/geist-latin-ext-wght-normal.woff2": { name: "fonts/geist-latin-ext-wght-normal.woff2", type: "font/woff2" },
  "/fonts/jetbrains-mono-latin-wght-normal.woff2": { name: "fonts/jetbrains-mono-latin-wght-normal.woff2", type: "font/woff2" },
  "/fonts/jetbrains-mono-latin-ext-wght-normal.woff2": { name: "fonts/jetbrains-mono-latin-ext-wght-normal.woff2", type: "font/woff2" },
};

export interface CompanionHttpOptions {
  port: number;
  token: string;
  /** Directory of the phone page: index.html, app.js, and the rest. */
  root: string;
  /** App icon, or null when there isn't one beside the page. */
  icon: string | null;
  actions: CompanionActions;
  /** The language setting ("system" or a code). The phone's own languages fill in for "system". */
  language?: () => string;
}

export interface CompanionHttp {
  port: number;
  close(): Promise<void>;
}

function text(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

/** A body of at most `max` bytes, refused before reading when it says it is longer. Only the first `keep` are kept. */
async function readRaw(req: http.IncomingMessage, max: number, keep = max): Promise<Buffer> {
  if (Number(req.headers["content-length"]) > max) throw new CompanionHttpError("phone.error.tooLarge", 413);
  const chunks: Buffer[] = [];
  let size = 0;
  let kept = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buf.length;
    if (size > max) throw new CompanionHttpError("phone.error.tooLarge", 413);
    if (kept < keep) {
      const part = buf.subarray(0, keep - kept);
      chunks.push(part);
      kept += part.length;
    }
  }
  return Buffer.concat(chunks);
}

async function readBody(req: http.IncomingMessage): Promise<unknown> {
  const raw = await readRaw(req, BODY_MAX);
  if (raw.length === 0) return {};
  try {
    return JSON.parse(raw.toString("utf8")) as unknown;
  } catch {
    throw new CompanionHttpError("phone.error.invalid", 400);
  }
}

/** A step's fields as the phone sent them: known keys, strings only, each kept to a sensible length. */
function stepPatch(value: unknown): StepPatch {
  const raw = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const patch: StepPatch = {};
  for (const [key, max] of [["engineId", 80], ["workspaceId", 80], ["target", 80], ["branch", 120], ["prompt", COMPANION_PROMPT_MAX]] as const) {
    if (typeof raw[key] === "string") patch[key] = (raw[key] as string).slice(0, max);
  }
  return patch;
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
  });
  res.end(payload);
}

function pagePath(root: string, name: string): string | null {
  const full = path.resolve(root, name);
  if (full !== path.resolve(root) && !full.startsWith(`${path.resolve(root)}${path.sep}`)) return null;
  return full;
}

/** What a request needs to know about the server it reached. */
interface Served {
  /** True once the page is turned off or its code replaced: nothing more is done for anyone. */
  stopping(): boolean;
}

/** Thrown once the server is stopping: the request gets no answer, its connection is cut. */
class Stopping extends Error {}

/** A body has been read, so the reply would act now: not on a server that is going away. */
function stillServing(served: Served): void {
  if (served.stopping()) throw new Stopping();
}

async function handle(req: http.IncomingMessage, res: http.ServerResponse, opts: CompanionHttpOptions, served: Served): Promise<void> {
  const url = new URL(req.url || "/", "http://127.0.0.1");
  const method = req.method || "GET";
  if (method === "GET" && url.pathname === "/icon.png") {
    if (!opts.icon) throw new CompanionHttpError("phone.error.notFound", 404);
    const icon = fs.readFileSync(opts.icon);
    res.writeHead(200, {
      "Content-Type": "image/png",
      "Content-Length": icon.length,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });
    res.end(icon);
    return;
  }
  const page = method === "GET" ? PAGES[url.pathname] : undefined;
  if (page) {
    const file = pagePath(opts.root, page.name);
    if (!file) throw new CompanionHttpError("phone.error.notFound", 404);
    const body = fs.readFileSync(file);
    res.writeHead(200, {
      "Content-Type": page.type,
      "Content-Length": body.length,
      "Cache-Control": "no-store",
      "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; manifest-src 'self'; worker-src 'self'; base-uri 'none'; object-src 'none'",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    });
    res.end(body);
    return;
  }
  if (!url.pathname.startsWith("/api/")) throw new CompanionHttpError("phone.error.notFound", 404);
  // The page's words, before pairing too: the pairing page needs them.
  if (method === "GET" && url.pathname === "/api/text") {
    const language = languageOf(req, opts);
    sendJson(res, 200, { language, words: await phoneWords(language) });
    return;
  }
  if (method === "POST" && url.pathname === "/api/pair") {
    const body = (await readBody(req)) as { token?: unknown };
    stillServing(served);
    if (!tokenMatches(opts.token, text(body.token, 80))) throw new CompanionHttpError("phone.error.wrongCode", 401);
    sendJson(res, 200, { ok: true });
    return;
  }
  if (!tokenMatches(opts.token, bearerToken(req.headers.authorization))) {
    throw new CompanionHttpError("phone.pairLead", 401);
  }
  if (method === "GET" && url.pathname === "/api/desk") {
    sendJson(res, 200, opts.actions.desk());
    return;
  }
  if (method === "GET" && url.pathname === "/api/plans") {
    sendJson(res, 200, { plans: await opts.actions.plans() });
    return;
  }
  if (method === "GET" && url.pathname === "/api/session") {
    sendJson(res, 200, await opts.actions.session({ ptyId: url.searchParams.get("ptyId") || "", runId: url.searchParams.get("runId") || "" }));
    return;
  }
  if (method === "GET" && url.pathname === "/api/orchestrator") {
    const view = opts.actions.orchestrator.view();
    // Why a step failed is the main process's own sentence, as the window translates it.
    const language = languageOf(req, opts);
    for (const turn of view.turns) {
      for (const step of turn.steps ?? []) if (step.error) step.error = await phoneCoreText(language, step.error);
    }
    sendJson(res, 200, view);
    return;
  }
  if (method !== "POST") throw new CompanionHttpError("phone.error.notFound", 404);
  if (url.pathname === "/api/orchestrator/hear") {
    const pcm = await readRaw(req, HEAR_READ_MAX, HEAR_MAX);
    stillServing(served);
    sendJson(res, 200, await opts.actions.hear(pcm));
    return;
  }
  const body = (await readBody(req)) as {
    ptyId?: unknown;
    runId?: unknown;
    text?: unknown;
    force?: unknown;
    workspaceId?: unknown;
    agentId?: unknown;
    engineId?: unknown;
    prompt?: unknown;
    turnId?: unknown;
    stepId?: unknown;
    patch?: unknown;
    engine?: unknown;
    mode?: unknown;
  };
  stillServing(served);
  if (url.pathname.startsWith("/api/orchestrator/")) {
    await orchestratorPost(url.pathname.slice("/api/orchestrator/".length), body, opts.actions.orchestrator);
    sendJson(res, 200, { ok: true });
    return;
  }
  if (url.pathname === "/api/send") {
    const ptyId = text(body.ptyId, 80);
    const runId = text(body.runId, 200);
    const prompt = text(body.text, COMPANION_PROMPT_MAX);
    if (!prompt) throw new CompanionHttpError("phone.error.empty", 400);
    if (!ptyId && !runId) throw new CompanionHttpError("phone.error.gone", 400);
    const result = await opts.actions.send({ ptyId, runId, text: prompt, force: body.force === true });
    if (result.working) throw new CompanionHttpError("phone.error.working", 409, { working: true });
    sendJson(res, 200, { ptyId: result.ptyId, runId: result.runId });
    return;
  }
  if (url.pathname === "/api/stop") {
    const ptyId = text(body.ptyId, 80);
    if (!ptyId) throw new CompanionHttpError("phone.error.gone", 400);
    await opts.actions.stop(ptyId);
    sendJson(res, 200, { ok: true });
    return;
  }
  if (url.pathname === "/api/launch") {
    const workspaceId = text(body.workspaceId, 80);
    const agentId = text(body.agentId, 80);
    const engineId = text(body.engineId, 80);
    if (!workspaceId || (!agentId && !engineId)) throw new CompanionHttpError("phone.error.choose", 400);
    sendJson(res, 200, await opts.actions.launch({ workspaceId, agentId, engineId, prompt: text(body.prompt, COMPANION_PROMPT_MAX) }));
    return;
  }
  throw new CompanionHttpError("phone.error.notFound", 404);
}

/** The Orchestrator's buttons: say something, Stop, New, Go, Cancel, a step changed or left out, and the view's header. */
async function orchestratorPost(
  action: string,
  body: { text?: unknown; turnId?: unknown; stepId?: unknown; patch?: unknown; engine?: unknown; mode?: unknown },
  desk: OrchestratorActions,
): Promise<void> {
  const turnId = text(body.turnId, 80);
  const stepId = text(body.stepId, 80);
  const needTurn = () => {
    if (!turnId) throw new CompanionHttpError("phone.error.invalid", 400);
    return turnId;
  };
  const needStep = () => {
    if (!stepId) throw new CompanionHttpError("phone.error.invalid", 400);
    return stepId;
  };
  if (action === "ask") {
    const words = text(body.text, COMPANION_PROMPT_MAX);
    if (!words) throw new CompanionHttpError("phone.error.empty", 400);
    desk.ask(words);
  } else if (action === "stop") desk.stopThinking();
  else if (action === "new") desk.clear();
  else if (action === "go") await desk.run(needTurn());
  else if (action === "cancel") desk.cancel(needTurn());
  else if (action === "step") desk.editStep(needTurn(), needStep(), stepPatch(body.patch));
  else if (action === "remove") desk.removeStep(needTurn(), needStep());
  else if (action === "settings") {
    const engine = text(body.engine, 80);
    const mode = body.mode === "plan" || body.mode === "go" ? body.mode : undefined;
    if (!engine && !mode) throw new CompanionHttpError("phone.error.invalid", 400);
    desk.settings({ ...(engine ? { engine } : {}), ...(mode ? { mode } : {}) });
  } else throw new CompanionHttpError("phone.error.notFound", 404);
}

function languageOf(req: http.IncomingMessage, opts: CompanionHttpOptions): PhoneLanguage {
  return phoneLanguage(opts.language?.() ?? "system", req.headers["accept-language"]);
}

/** What went wrong, in the phone's language. A service's sentence is translated when the app knows it. */
async function errorText(error: unknown, language: PhoneLanguage): Promise<string> {
  if (error instanceof CompanionHttpError) return phoneSay(language, error.key);
  const message = error instanceof Error && error.message ? error.message.split("\n")[0].slice(0, 300) : "";
  return message ? phoneCoreText(language, message) : phoneSay(language, "phone.error.failed");
}

/** The phone page and its API, on loopback. The caller binds the address. */
export function startCompanionHttp(opts: CompanionHttpOptions & { host?: string }): Promise<CompanionHttp> {
  // Off, a new code and Quit all stop this server. A phone that was connected gets nothing more from it:
  // its connection would otherwise keep this handler, and the old code, for as long as it polls.
  let stopping = false;
  const served: Served = { stopping: () => stopping };
  const server = http.createServer((req, res) => {
    if (stopping) {
      res.destroy();
      return;
    }
    handle(req, res, opts, served).catch(async (error: unknown) => {
      if (res.headersSent || stopping || error instanceof Stopping) {
        res.destroy();
        return;
      }
      // The service throws a sentence ("Atlas is not allowed in Notes"). That is the reply.
      const status = error instanceof CompanionHttpError ? error.status : 400;
      const extra = error instanceof CompanionHttpError ? error.extra : undefined;
      // What is left of a body too large to read is not read: the connection ends with the reply.
      if (status === 413) res.setHeader("Connection", "close");
      const text = await errorText(error, languageOf(req, opts)).catch(() => "Something went wrong.");
      if (!res.headersSent) sendJson(res, status, { error: text, ...extra });
    });
  });
  const host = opts.host ?? "127.0.0.1";
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port, host, () => {
      const address = server.address();
      const port = address && typeof address === "object" ? address.port : opts.port;
      resolve({
        port,
        close: () =>
          new Promise((done) => {
            stopping = true;
            server.close(() => done());
            // A phone polling every two seconds never goes idle, so close alone would wait on it forever.
            server.closeAllConnections();
          }),
      });
    });
  });
}
