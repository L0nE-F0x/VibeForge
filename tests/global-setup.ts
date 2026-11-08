import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// One temp folder per test run, removed once every test file is done (and its services and
// terminals with it), so a run leaves nothing behind in /tmp. The workers inherit TMPDIR.
export default function setup(): () => void {
  const before = process.env.TMPDIR;
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "vibeforge-tests-"));
  process.env.TMPDIR = folder;
  return () => {
    if (before === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = before;
    fs.rmSync(folder, { recursive: true, force: true });
  };
}
