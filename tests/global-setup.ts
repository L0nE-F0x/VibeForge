import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// The tests build their own repositories (init, commit, push to a bare one in the temp folder), so
// what a contributor has in their own git config must not decide whether they pass: a global
// core.hooksPath with a pre-push or pre-commit scanner refuses those pushes, and init.defaultBranch
// renames the branch the fixtures expect. Git reads no global or system file during the run; the
// tests pass the identity they need with -c.
const GIT_ENV: Record<string, string> = { GIT_CONFIG_GLOBAL: os.devNull, GIT_CONFIG_NOSYSTEM: "1" };

// One temp folder per test run, removed once every test file is done (and its services and
// terminals with it), so a run leaves nothing behind in /tmp. The workers inherit TMPDIR and the
// git settings above.
export default function setup(): () => void {
  const before = process.env.TMPDIR;
  const beforeGit = Object.fromEntries(Object.keys(GIT_ENV).map((name) => [name, process.env[name]]));
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "vibeforge-tests-"));
  process.env.TMPDIR = folder;
  Object.assign(process.env, GIT_ENV);
  return () => {
    if (before === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = before;
    for (const [name, value] of Object.entries(beforeGit)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    fs.rmSync(folder, { recursive: true, force: true });
  };
}
