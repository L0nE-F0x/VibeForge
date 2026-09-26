import { execFile } from "node:child_process";

interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  missing: boolean;
}

/**
 * Every git call here is read-only. `--no-optional-locks` keeps status from touching the index
 * while an agent works; `color.ui=never` keeps escape codes out even when someone's git config
 * says `color.ui = always`.
 */
function execGit(args: readonly string[], cwd: string, timeoutMs: number, maxBuffer = 8 * 1024 * 1024): Promise<GitResult> {
  return new Promise((resolve) => {
    execFile(
      "git",
      ["--no-optional-locks", "-c", "color.ui=never", ...args],
      { cwd, timeout: Math.max(1, timeoutMs), encoding: "utf8", maxBuffer, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } },
      (error, stdout, stderr) => {
        const err = error as (NodeJS.ErrnoException & { killed?: boolean }) | null;
        resolve({
          code: typeof err?.code === "number" ? err.code : err ? 1 : 0,
          stdout: stdout ?? "",
          stderr: stderr ?? "",
          timedOut: Boolean(err?.killed) || /timed out|ETIMEDOUT/i.test(err?.message ?? ""),
          missing: err?.code === "ENOENT",
        });
      },
    );
  });
}

export const NOT_A_REPO = "not a git repo";

/**
 * Your commits in a repository since a date, one entry per commit: its hash and its author date
 * (YYYY-MM-DD, local). "Yours" means the repository's user.email; without one, every commit counts.
 */
export async function commitDays(cwd: string, since: string, timeoutMs = 8000): Promise<Array<{ hash: string; day: string }>> {
  const email = (await execGit(["config", "user.email"], cwd, timeoutMs)).stdout.trim();
  const args = ["log", "--all", "--no-merges", `--since=${since}`, "--date=short-local", "--format=%H %ad"];
  if (email) args.push(`--author=${email}`);
  const log = await execGit(args, cwd, timeoutMs, 32 * 1024 * 1024);
  if (log.code !== 0) return [];
  return log.stdout
    .split("\n")
    .map((line) => line.trim().split(" "))
    .filter((parts) => parts.length === 2 && /^\d{4}-\d{2}-\d{2}$/.test(parts[1]))
    .map(([hash, day]) => ({ hash, day }));
}

export async function gitHead(cwd: string, timeoutMs = 3000): Promise<string | null> {
  if (!cwd) return null;
  const result = await execGit(["rev-parse", "--verify", "-q", "HEAD"], cwd, timeoutMs);
  const sha = result.stdout.trim();
  return result.code === 0 && /^[0-9a-f]{7,64}$/.test(sha) ? sha : null;
}

export async function isGitRepo(cwd: string, timeoutMs = 3000): Promise<boolean> {
  if (!cwd) return false;
  const result = await execGit(["rev-parse", "--is-inside-work-tree"], cwd, timeoutMs);
  return result.code === 0 && result.stdout.trim() === "true";
}

/**
 * The review snapshot written to git.txt when a run ends: status, diff stat, and any
 * commits made since the run started.
 */
export async function snapshotGit(cwd: string, timeoutMs = 5000, startHead: string | null = null): Promise<string> {
  if (!cwd) return `${NOT_A_REPO}\n`;
  const started = Date.now();
  const budget = () => Math.max(1, timeoutMs - (Date.now() - started));
  const status = await execGit(["status", "--short"], cwd, budget());
  if (status.timedOut) return "git timed out\n";
  if (status.missing || /not a git repository/i.test(status.stderr) || /no such file or directory/i.test(status.stderr)) {
    return `${NOT_A_REPO}\n`;
  }
  if (status.code !== 0) return `git status --short\n${status.stderr.trim() || "git status failed"}\n`;
  const sections = [`git status --short\n${status.stdout.trimEnd()}`];
  const diff = await execGit(["diff", "--stat"], cwd, budget());
  if (diff.timedOut) return `${sections.join("\n\n")}\n\ngit timed out\n`;
  sections.push(`git diff --stat\n${diff.stdout.trimEnd()}`);
  if (startHead) {
    const log = await execGit(["log", "--oneline", "--no-decorate", `${startHead}..HEAD`], cwd, budget());
    if (!log.timedOut && log.code === 0 && log.stdout.trim()) {
      sections.push(`commits since the run started\n${log.stdout.trimEnd()}`);
    }
  }
  return `${sections.join("\n\n")}\n`;
}

/** Full diff for the review screen: everything since the run's starting HEAD, plus untracked file names. */
export async function diffSince(cwd: string, startHead: string | null, timeoutMs = 8000): Promise<string> {
  if (!(await isGitRepo(cwd))) return "";
  const args = startHead ? ["diff", "--no-color", startHead] : ["diff", "--no-color", "HEAD"];
  let diff = await execGit(args, cwd, timeoutMs, 16 * 1024 * 1024);
  if (diff.code !== 0 && !startHead) diff = await execGit(["diff", "--no-color"], cwd, timeoutMs, 16 * 1024 * 1024);
  const untracked = await execGit(["ls-files", "--others", "--exclude-standard"], cwd, timeoutMs);
  let text = diff.stdout;
  const extra = untracked.stdout.trim();
  if (extra) {
    text += `${text && !text.endsWith("\n") ? "\n" : ""}\n# Untracked files\n${extra
      .split("\n")
      .map((line) => `+ ${line}`)
      .join("\n")}\n`;
  }
  return text;
}

/** "3 files changed, 20 insertions(+)" from a git.txt snapshot, or null. */
export function summarizeSnapshot(text: string): string | null {
  if (!text || text.startsWith(NOT_A_REPO)) return null;
  const stat = text.match(/\d+ files? changed[^\n]*/);
  const commits = text.split("commits since the run started\n")[1]?.trim().split("\n").filter(Boolean).length ?? 0;
  const statusBlock = text.split("git status --short\n")[1]?.split("\n\n")[0] ?? "";
  const statusLines = statusBlock.split("\n").filter((line) => line.trim());
  const untracked = statusLines.filter((line) => line.startsWith("??")).length;
  const touched = statusLines.length - untracked;
  const parts: string[] = [];
  if (commits) parts.push(`${commits} commit${commits === 1 ? "" : "s"}`);
  if (stat) parts.push(stat[0].trim());
  else if (touched) parts.push(`${touched} file${touched === 1 ? "" : "s"} touched`);
  if (untracked) parts.push(`${untracked} new file${untracked === 1 ? "" : "s"}`);
  return parts.length ? parts.join(" · ") : "No changes";
}
