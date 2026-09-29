import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  missing: boolean;
  /** stdout hit the buffer cap and was cut off. */
  truncated: boolean;
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
      [
        "--no-pager",
        "--no-optional-locks",
        "-c",
        "color.ui=never",
        "-c",
        "diff.mnemonicPrefix=false",
        "-c",
        "diff.noprefix=false",
        "-c",
        "core.quotePath=false",
        ...args,
      ],
      { cwd, timeout: Math.max(1, timeoutMs), encoding: "utf8", maxBuffer, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } },
      (error, stdout, stderr) => {
        const err = error as (NodeJS.ErrnoException & { killed?: boolean }) | null;
        resolve({
          code: typeof err?.code === "number" ? err.code : err ? 1 : 0,
          stdout: stdout ?? "",
          stderr: stderr ?? "",
          timedOut: Boolean(err?.killed) || /timed out|ETIMEDOUT/i.test(err?.message ?? ""),
          missing: err?.code === "ENOENT",
          truncated: /maxBuffer|STDIO_MAXBUFFER/i.test(err?.message ?? ""),
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
 * The review summary written to git.txt when a run ends: status, diff stat, and any
 * commits made since the run started. The full patch is `diffSince`, saved beside it.
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

/** A new file larger than this is named in the patch and left on disk. */
export const NEW_FILE_LIMIT = 256 * 1024;
const MAX_PATCH = 2 * 1024 * 1024;
const MAX_NEW_FILES = 200;

/**
 * Full patch for a run: tracked changes since the starting commit, then the text of new files.
 * Read-only. Saved to diff.patch when the run ends, so later edits in the folder don't replace it.
 * `git diff` omits untracked files, so their contents are read and formatted here.
 */
export async function diffSince(cwd: string, startHead: string | null, timeoutMs = 8000): Promise<string> {
  if (!cwd || !(await isGitRepo(cwd, Math.min(3000, Math.max(1, timeoutMs))))) return "";
  const started = Date.now();
  const budget = () => Math.max(1, timeoutMs - (Date.now() - started));
  const tracked = await trackedDiff(cwd, startHead, budget);
  if (tracked.includes("# saved diff truncated") || tracked.length >= MAX_PATCH) return capPatch(tracked);
  const created = await newFileDiffs(cwd, budget, MAX_PATCH - tracked.length);
  return capPatch(joinBlocks(tracked, created));
}

/** Tracked changes since the run's start commit. A missing start commit falls back to HEAD, then the index. */
async function trackedDiff(cwd: string, startHead: string | null, budget: () => number): Promise<string> {
  const attempts: string[][] = startHead
    ? [["diff", "--no-color", startHead], ["diff", "--no-color", "HEAD"], ["diff", "--no-color"]]
    : [["diff", "--no-color", "HEAD"], ["diff", "--no-color"]];
  for (const args of attempts) {
    const diff = await execGit(args, cwd, budget(), MAX_PATCH);
    if (diff.timedOut) return "# git diff timed out\n";
    if (diff.truncated) return `${diff.stdout}\n# saved diff truncated\n`;
    if (diff.code === 0 || diff.stdout.trim()) return diff.stdout;
  }
  return "";
}

/** New files as normal "new file" diffs. Binary and oversized ones are named, not copied in. */
async function newFileDiffs(cwd: string, budget: () => number, room: number): Promise<string> {
  if (room <= 0) return "# New files left in the working tree\n# the saved diff is full\n";
  const listed = await execGit(["ls-files", "--others", "--exclude-standard", "-z"], cwd, budget());
  if (listed.timedOut) return "# listing new files timed out\n";
  if (listed.code !== 0) return "";
  const names = listed.stdout.split("\0").filter(Boolean);
  const blocks: string[] = [];
  const skipped: string[] = [];
  let used = 0;
  for (let index = 0; index < names.length; index += 1) {
    const name = names[index];
    if (index >= MAX_NEW_FILES) {
      skipped.push(`${names.length - index} more new files, left in the working tree`);
      break;
    }
    if (budget() <= 1) {
      skipped.push(`${names.length - index} more new files: timed out`);
      break;
    }
    const block = readNewFile(cwd, name);
    if (typeof block !== "string") {
      skipped.push(block.skip);
      continue;
    }
    if (used + block.length > room) {
      skipped.push(`${names.length - index} more new files: the saved diff is full`);
      break;
    }
    blocks.push(block);
    used += block.length;
  }
  let text = blocks.join("");
  if (skipped.length) {
    text += "# New files left in the working tree\n";
    for (const line of skipped) text += `# ${line}\n`;
  }
  return text;
}

/** A unified diff for one new file, or a skip reason when it should stay on disk only. */
function readNewFile(cwd: string, name: string): string | { skip: string } {
  const full = fileInWorkTree(cwd, name);
  if (!full) return { skip: `${name}: skipped` };
  let st: fs.Stats;
  try {
    st = fs.lstatSync(full);
  } catch {
    return { skip: `${name}: could not be read` };
  }
  if (st.isSymbolicLink()) {
    try {
      return unifiedNewFile(name, "120000", fs.readlinkSync(full));
    } catch {
      return { skip: `${name}: could not be read` };
    }
  }
  if (!st.isFile()) return { skip: `${name}: not a regular file` };
  if (st.size > NEW_FILE_LIMIT) return { skip: `${name}: ${st.size} bytes, left in the working tree` };
  if (looksBinary(full)) return { skip: `${name}: binary, left in the working tree` };
  try {
    const mode = st.mode & 0o111 ? "100755" : "100644";
    return unifiedNewFile(name, mode, fs.readFileSync(full, "utf8"));
  } catch {
    return { skip: `${name}: could not be read` };
  }
}

function unifiedNewFile(rel: string, mode: string, raw: string): string {
  const header = `diff --git a/${rel} b/${rel}\nnew file mode ${mode}\n--- /dev/null\n+++ b/${rel}\n`;
  if (raw.length === 0) return header;
  const missingNewline = !raw.endsWith("\n");
  const lines = raw.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  const body = lines.map((line) => `+${line}`).join("\n");
  const tail = missingNewline ? "\n\\ No newline at end of file\n" : "\n";
  return `${header}@@ -0,0 +1,${lines.length} @@\n${body}${tail}`;
}

function looksBinary(file: string): boolean {
  let fd: number | null = null;
  try {
    fd = fs.openSync(file, "r");
    const buf = Buffer.alloc(8000);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    return buf.subarray(0, n).includes(0);
  } catch {
    return false;
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

/** A git path relative to the work tree, or null when it could leave that folder. */
function fileInWorkTree(cwd: string, rel: string): string | null {
  if (!rel || /[\0\n\r"]/.test(rel) || path.isAbsolute(rel)) return null;
  const parts = rel.split(/[/\\]/);
  if (parts.some((part) => part === ".." || part === "")) return null;
  const root = path.resolve(cwd);
  const full = path.resolve(root, rel);
  if (full !== root && !full.startsWith(`${root}${path.sep}`)) return null;
  return full;
}

function joinBlocks(left: string, right: string): string {
  if (!left) return right;
  if (!right) return left;
  return left.endsWith("\n") ? `${left}${right}` : `${left}\n${right}`;
}

function capPatch(text: string): string {
  if (text.length <= MAX_PATCH) return text;
  const cut = text.slice(0, MAX_PATCH);
  return `${cut.endsWith("\n") ? cut : `${cut}\n`}# saved diff truncated\n`;
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
