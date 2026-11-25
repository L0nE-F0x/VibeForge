import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { cleanModel, effortLevels } from "../../shared/launch-options.js";
import { brainKind, extractEarlySay, PLAN_SCHEMA, type BrainOptions, type ClaudeInlineImage } from "../orchestrator.js";
import type { EngineRow } from "../types.js";
import { plannerEnv, type BrainRun } from "./orchestrator.js";

const WARM_IDLE_MS = 2 * 60_000;
const KILL_GRACE_MS = 3000;
const MAX_LINE_BYTES = 4 * 1024 * 1024;

export interface ClaudeStreamTurnRequest {
  binPath: string;
  row: EngineRow;
  opts: BrainOptions;
  images?: ClaudeInlineImage[];
  cwd: string;
  signal: AbortSignal;
  timeoutMs: number;
  onEarlySay?: (say: string) => void;
}

/** Build persistent stdio `stream-json` arguments for Claude Code multi-turn planning sessions. */
export function claudeStreamArgs(row: EngineRow, opts: BrainOptions): string[] | null {
  if (brainKind(row) !== "claude") return null;
  const model = cleanModel(opts.model);
  const allowedEfforts = effortLevels(row);
  const requestedEffort = (opts.effort ?? "").trim().toLowerCase();
  const effort = requestedEffort && allowedEfforts.includes(requestedEffort) ? requestedEffort : "low";
  return [
    ...row.args,
    "--tools",
    "",
    "--print",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--include-partial-messages",
    "--verbose",
    "--json-schema",
    JSON.stringify(PLAN_SCHEMA),
    "--append-system-prompt",
    opts.rules,
    "--effort",
    effort,
    "--strict-mcp-config",
    ...(model ? ["--model", model] : []),
    opts.resume ? "--resume" : "--session-id",
    opts.sessionId,
  ];
}

export function claudeStreamUserLine(text: string, images?: ReadonlyArray<ClaudeInlineImage>): string {
  const content: Array<Record<string, unknown>> = (images ?? []).map((img) => ({
    type: "image",
    source: { type: "base64", media_type: img.mediaType, data: img.base64 },
  }));
  content.push({ type: "text", text });
  return `${JSON.stringify({ type: "user", message: { role: "user", content } })}\n`;
}

interface WarmClaudeSession {
  key: string;
  child: ChildProcess;
  cwd: string;
  stderr: string;
  dead: boolean;
  busy: boolean;
  onLine: ((line: string) => void) | null;
  onDead: ((code: number | null) => void) | null;
}

/**
 * Pool storing at most one warm persistent `stream-json` Claude Code planner process so consecutive
 * turns in the same conversation avoid CLI startup latency and stream `"say"` early before exit.
 */
export class PlannerSessionPool {
  private session: WarmClaudeSession | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  readonly idleMs: number;

  constructor(idleMs = WARM_IDLE_MS) {
    this.idleMs = idleMs;
  }

  get activePid(): number | null {
    return this.session && !this.session.dead ? (this.session.child.pid ?? null) : null;
  }

  private touchIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      if (this.session?.busy) this.touchIdle();
      else this.dropSession();
    }, this.idleMs);
    this.idleTimer.unref();
  }

  private killGroup(child: ChildProcess, sig: NodeJS.Signals): void {
    if (child.pid === undefined) return;
    try {
      process.kill(-child.pid, sig);
    } catch {
      /* already exited */
    }
  }

  dropSession(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    const cur = this.session;
    this.session = null;
    if (!cur || cur.dead) return;
    cur.dead = true;
    const child = cur.child;
    this.killGroup(child, "SIGTERM");
    const hard = setTimeout(() => this.killGroup(child, "SIGKILL"), KILL_GRACE_MS);
    hard.unref();
    cur.onDead?.(null);
  }

  dispose(): void {
    this.dropSession();
  }

  private spawnSession(key: string, binPath: string, args: string[], cwd: string): WarmClaudeSession {
    const child = spawn(binPath, args, {
      cwd: path.resolve(cwd),
      env: plannerEnv(),
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    });
    const entry: WarmClaudeSession = {
      key,
      child,
      cwd: path.resolve(cwd),
      stderr: "",
      dead: false,
      busy: false,
      onLine: null,
      onDead: null,
    };
    let lineBuf = "";
    child.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
      if (lineBuf.length < MAX_LINE_BYTES) lineBuf += chunk.slice(0, MAX_LINE_BYTES - lineBuf.length);
      let nl = lineBuf.indexOf("\n");
      while (nl >= 0) {
        const line = lineBuf.slice(0, nl).trim();
        lineBuf = lineBuf.slice(nl + 1);
        if (line) entry.onLine?.(line);
        nl = lineBuf.indexOf("\n");
      }
    });
    child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
      entry.stderr = (entry.stderr + chunk).slice(-8000);
    });
    child.stdin?.on("error", () => undefined);
    const finish = (code: number | null) => {
      if (entry.dead) return;
      entry.dead = true;
      if (this.session === entry) this.session = null;
      if (lineBuf.trim()) entry.onLine?.(lineBuf.trim());
      lineBuf = "";
      entry.onDead?.(code);
    };
    child.on("error", (err) => {
      entry.stderr += err.message;
      finish(127);
    });
    child.on("close", (code) => finish(code));
    this.session = entry;
    this.touchIdle();
    return entry;
  }

  /**
   * Execute one turn on a warm session if compatible, or start one; returns `null` if args cannot
   * use streaming persistent mode.
   */
  runTurn(req: ClaudeStreamTurnRequest): Promise<BrainRun | null> {
    const args = claudeStreamArgs(req.row, req.opts);
    if (!args) return Promise.resolve(null);
    const model = cleanModel(req.opts.model);
    const effort = (req.opts.effort ?? "").trim().toLowerCase() || "low";
    const resolvedCwd = path.resolve(req.cwd);
    const sessionKey = `${req.binPath}\0${resolvedCwd}\0${req.opts.sessionId}\0${model}\0${effort}`;

    // If a turn is already active on the slot, drop and let caller fall back or start clean.
    if (this.session && (this.session.key !== sessionKey || this.session.dead || this.session.busy || this.session.child.exitCode !== null)) {
      this.dropSession();
    }
    const entry = this.session ?? this.spawnSession(sessionKey, req.binPath, args, resolvedCwd);
    entry.busy = true;
    this.touchIdle();

    return new Promise((resolve) => {
      let finished = false;
      let timedOut = false;
      let rawBuffer = "";
      let resultLine = "";
      let emittedEarlySay = "";

      const finish = (code: number | null) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        req.signal.removeEventListener("abort", onAbort);
        entry.busy = false;
        entry.onLine = null;
        entry.onDead = null;
        this.touchIdle();
        resolve({
          code,
          stdout: resultLine || rawBuffer,
          stderr: entry.stderr,
          timedOut,
        });
      };

      const onAbort = () => {
        this.dropSession();
        finish(null);
      };

      const timer = setTimeout(() => {
        timedOut = true;
        this.dropSession();
        finish(null);
      }, req.timeoutMs);

      if (req.signal.aborted) {
        onAbort();
        return;
      }
      req.signal.addEventListener("abort", onAbort, { once: true });

      entry.onDead = (code) => finish(code);
      entry.onLine = (line) => {
        if (rawBuffer.length < MAX_LINE_BYTES) rawBuffer += `${line}\n`;
        if (!emittedEarlySay && req.onEarlySay) {
          const say = extractEarlySay(rawBuffer);
          if (say) {
            emittedEarlySay = say;
            req.onEarlySay(say);
          }
        }
        try {
          const ev = JSON.parse(line) as { type?: unknown };
          if (ev.type === "result") {
            resultLine = line;
            finish(0);
          }
        } catch {
          /* ignore non-json line */
        }
      };

      try {
        entry.child.stdin?.write(claudeStreamUserLine(req.opts.text, req.images));
      } catch (err) {
        entry.stderr += err instanceof Error ? err.message : String(err);
        this.dropSession();
        finish(1);
      }
    });
  }
}
