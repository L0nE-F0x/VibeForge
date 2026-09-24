const { execFile } = require("child_process");

function git(cwd, args, timeoutMs) {
  return new Promise((resolve) => {
    execFile(
      "git",
      args,
      { cwd, timeout: timeoutMs, encoding: "utf8", maxBuffer: 2 * 1024 * 1024 },
      (err, stdout) => {
        if (err) resolve(null);
        else resolve(stdout ?? "");
      },
    );
  });
}

async function snapshotGit(cwd, timeoutMs = 5000) {
  const status = await git(cwd, ["status", "--short"], timeoutMs);
  if (status === null) return "not a git repo\n";
  const diff = await git(cwd, ["diff", "--stat"], timeoutMs);
  return `git status --short\n${status}\ngit diff --stat\n${diff ?? ""}\n`;
}

module.exports = { snapshotGit };
