import { spawn } from "node:child_process";

/**
 * Git flags applied to every command VibeForge runs: disable repository-controlled hooks
 * (including `post-checkout` when opening a branch or task copy so untrusted repos cannot run
 * arbitrary scripts automatically), disable filesystem monitor daemons, and refuse automatic
 * `file://` fetches in submodules or remotes.
 */
export const HARDENED_GIT_ARGS = [
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "protocol.file.allow=user",
] as const;

/** Leading global git options that take a separate value argument before the subcommand. */
const VALUE_GLOBAL_OPTS = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--super-prefix", "--exec-path", "--config-env"]);

/** Prepend hardened global flags and disable external diff / textconv on diff, show, and `log -p`. */
export function hardenGitArgs(args: readonly string[]): string[] {
  const head: string[] = ["--no-pager", ...HARDENED_GIT_ARGS];
  let subIndex = -1;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--") break;
    if (VALUE_GLOBAL_OPTS.has(arg)) {
      i += 1;
      continue;
    }
    if (arg.startsWith("-")) continue;
    subIndex = i;
    break;
  }
  if (subIndex < 0) return [...head, ...args];

  const sub = args[subIndex];
  const rest = args.slice(subIndex + 1);
  const endOpts = rest.indexOf("--");
  const subOpts = endOpts >= 0 ? rest.slice(0, endOpts) : rest;
  const wantsNoExtDiff =
    sub === "diff" ||
    sub === "show" ||
    (sub === "log" && subOpts.some((opt) => opt === "-p" || opt === "--patch" || opt === "-u" || /^-[A-Za-z]*p/.test(opt)));

  if (!wantsNoExtDiff) return [...head, ...args];

  const extra: string[] = [];
  if (!subOpts.includes("--no-ext-diff")) extra.push("--no-ext-diff");
  if (!subOpts.includes("--no-textconv")) extra.push("--no-textconv");
  return [...head, ...args.slice(0, subIndex + 1), ...extra, ...rest];
}

export interface GitRunOptions {
  cwd?: string;
  input?: string;
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
  maxBuffer?: number;
}

export interface GitBytesResult {
  code: number;
  stdout: Buffer;
  stderr: string;
  timedOut: boolean;
  missing: boolean;
  truncated: boolean;
}

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  missing: boolean;
  truncated: boolean;
}

/** Spawn `git` with hardened flags, no interactive prompts, optional stdin/timeout/maxBuffer. */
export function runGitBytes(args: readonly string[], options: GitRunOptions = {}): Promise<GitBytesResult> {
  return new Promise((resolve) => {
    const child = spawn("git", hardenGitArgs(args), {
      cwd: options.cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "", GCM_INTERACTIVE: "never", ...options.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let stderr = "";
    let timedOut = false;
    let missing = false;
    let truncated = false;
    let settled = false;

    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({ code, stdout: Buffer.concat(chunks), stderr, timedOut, missing, truncated });
    };

    const timeoutMs = options.timeoutMs;
    const timer =
      timeoutMs && timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            child.kill("SIGKILL");
          }, timeoutMs)
        : null;

    child.stdout.on("data", (chunk: Buffer) => {
      const cap = options.maxBuffer;
      if (cap !== undefined && totalBytes + chunk.length > cap) {
        const room = Math.max(0, cap - totalBytes);
        if (room > 0) chunks.push(chunk.subarray(0, room));
        totalBytes = cap;
        truncated = true;
        child.kill("SIGKILL");
        return;
      }
      chunks.push(chunk);
      totalBytes += chunk.length;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    child.on("error", (error) => {
      missing = (error as NodeJS.ErrnoException).code === "ENOENT";
      if (!stderr) stderr = error.message;
      finish(127);
    });
    child.on("close", (code) => finish(code ?? 1));
    child.stdin.on("error", () => undefined);
    child.stdin.end(options.input ?? "");
  });
}

/** Same as `runGitBytes`, decoding stdout as UTF-8. */
export async function runGit(args: readonly string[], options: GitRunOptions = {}): Promise<GitResult> {
  const run = await runGitBytes(args, options);
  return { ...run, stdout: run.stdout.toString("utf8") };
}
