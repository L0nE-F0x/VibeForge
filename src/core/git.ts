import { execFile } from "node:child_process";

interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  missing: boolean;
}

function execGit(args: readonly string[], cwd: string, timeoutMs: number): Promise<GitResult> {
  return new Promise((resolve) => {
    execFile(
      "git",
      [...args],
      {
        cwd,
        timeout: Math.max(1, timeoutMs),
        encoding: "utf8",
        windowsHide: true,
        maxBuffer: 8 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        const err = error as (NodeJS.ErrnoException & { killed?: boolean; signal?: string }) | null;
        const message = err?.message ?? "";
        resolve({
          code: typeof err?.code === "number" ? err.code : err ? 1 : 0,
          stdout: stdout ?? "",
          stderr: stderr ?? "",
          timedOut: Boolean(err?.killed) || /timed out|ETIMEDOUT/i.test(message),
          missing: err?.code === "ENOENT",
        });
      },
    );
  });
}

function notRepo(stderr: string, stdout: string): boolean {
  const text = `${stderr}\n${stdout}`;
  return /not a git repository/i.test(text) || /not a git repo/i.test(text);
}

export async function snapshotGit(cwd: string, timeoutMs = 5000): Promise<string> {
  if (!cwd) return "not a git repo";
  const started = Date.now();
  const budget = () => Math.max(1, timeoutMs - (Date.now() - started));
  const status = await execGit(["status", "--short"], cwd, budget());
  if (status.timedOut) return "git timed out";
  if (
    status.missing ||
    notRepo(status.stderr, status.stdout) ||
    /no such file or directory/i.test(status.stderr)
  ) {
    return "not a git repo";
  }
  if (status.code !== 0) {
    const detail = status.stderr.trim() || "git status failed";
    return `git status --short\n${detail}\n`;
  }
  const diff = await execGit(["diff", "--stat"], cwd, budget());
  if (diff.timedOut) return "git timed out";
  if (diff.missing || notRepo(diff.stderr, diff.stdout)) return "not a git repo";
  const statusText = status.stdout.replace(/\s+$/u, "");
  const diffText = diff.stdout.replace(/\s+$/u, "");
  return `git status --short\n${statusText}\n\ngit diff --stat\n${diffText}\n`;
}
