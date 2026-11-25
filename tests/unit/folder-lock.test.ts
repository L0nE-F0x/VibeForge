import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { holdFolders, lockName } from "../../src/core/folder-lock.js";

// One VibeForge per folder: a second copy on the same config or data folder, under any Electron
// profile, is told the folder is taken; a copy that crashed leaves nothing behind to clear.

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "vf-lock-"));
}

describe("holding the config and data folders", () => {
  it("refuses a folder that is held, by any path to it, and lets go of every folder on release", async () => {
    const data = tempDir();
    const config = tempDir();
    const link = path.join(tempDir(), "data-link");
    fs.symlinkSync(data, link);
    expect(lockName(link)).toBe(lockName(data));
    expect(lockName(config)).not.toBe(lockName(data));

    const first = await holdFolders([data, config]);
    expect(first.ok).toBe(true);
    // Another copy with the same data folder (through a link) and folders of its own otherwise.
    expect(await holdFolders([tempDir(), link], { waitMs: 0 })).toEqual({ ok: false, folder: link });
    // Its own folders are free: a trial window beside the installed copy.
    const trial = await holdFolders([tempDir(), tempDir()], { waitMs: 0 });
    expect(trial.ok).toBe(true);
    if (trial.ok) trial.release();
    // A refused copy holds nothing of what it got before the taken one.
    const mixed = tempDir();
    expect((await holdFolders([mixed, config], { waitMs: 0 })).ok).toBe(false);
    const free = await holdFolders([mixed], { waitMs: 0 });
    expect(free.ok).toBe(true);
    if (free.ok) free.release();

    if (first.ok) first.release();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const second = await holdFolders([data, config], { waitMs: 0 });
    expect(second.ok).toBe(true);
    if (second.ok) second.release();
  });

  it("gets the folder once the copy holding it has gone, within the wait", async () => {
    const data = tempDir();
    const first = await holdFolders([data]);
    expect(first.ok).toBe(true);
    setTimeout(() => first.ok && first.release(), 150);
    const second = await holdFolders([data], { waitMs: 2000, retryMs: 50 });
    expect(second.ok).toBe(true);
    if (second.ok) second.release();
  });

  it("is free again the moment a copy holding it is killed, with nothing left to clear", async () => {
    const data = tempDir();
    const name = lockName(data);
    // A process that holds the folder the same way, then dies without a chance to let go.
    const child = spawn(process.execPath, ["-e", `require("node:net").createServer().listen(${JSON.stringify(name)}, () => console.log("held"))`], { stdio: ["ignore", "pipe", "inherit"] });
    await new Promise<void>((resolve) => child.stdout.once("data", () => resolve()));
    expect(await holdFolders([data], { waitMs: 0 })).toEqual({ ok: false, folder: data });
    const gone = new Promise((resolve) => child.once("exit", resolve));
    child.kill("SIGKILL");
    await gone;
    const after = await holdFolders([data], { waitMs: 1000, retryMs: 20 });
    expect(after.ok).toBe(true);
    if (after.ok) after.release();
    // Nothing on disk was ever made for it.
    expect(fs.readdirSync(data)).toEqual([]);
  });
});
