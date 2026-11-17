import { execFileSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Syncthing } from "../../electron/sync-engine.js";
import { SyncDesk, type SyncDeskHost } from "../../src/core/sync/desk.js";
import type { LiveSession, Workspace } from "../../src/core/types.js";

// Two "machines" on this one: each a SyncDesk with its own data folder and home, driving its own
// private Syncthing (the pinned binary in vendor/syncthing) on loopback. Everything a person does
// with sync is done here for real: pair, share a workspace, accept it, change it on both sides,
// commit on both sides while apart, change the mode, stop. Skipped where the binary isn't fetched
// (`node scripts/fetch-syncthing.mjs`); CI fetches it.

const repo = path.resolve(import.meta.dirname, "..", "..");
const binary = process.env.VIBEFORGE_SYNCTHING || path.join(repo, "vendor", "syncthing", "syncthing");
const have = fs.existsSync(binary);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until<T>(what: string, check: () => T | Promise<T>, ms = 60_000): Promise<NonNullable<T>> {
  const end = Date.now() + ms;
  let last: unknown;
  while (Date.now() < end) {
    try {
      const value = await check();
      if (value) return value as NonNullable<T>;
    } catch (error) {
      last = error;
    }
    await sleep(150);
  }
  throw new Error(`Timed out waiting for ${what}${last ? `: ${String(last)}` : ""}`);
}

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as net.AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

interface Machine {
  name: string;
  home: string;
  desk: SyncDesk;
  engine: Syncthing;
  workspaces: Workspace[];
  live: LiveSession[];
  notes: string[];
  logs: string[];
}

async function machine(name: string, base: string): Promise<Machine> {
  const home = path.join(base, name, "home");
  const dataRoot = path.join(base, name, "data");
  fs.mkdirSync(home, { recursive: true });
  const port = await freePort();
  const made: Partial<Machine> = { name, home, workspaces: [], live: [], notes: [], logs: [] };
  const host: SyncDeskHost = {
    home,
    machineName: () => name,
    addresses: () => [`127.0.0.1:${port}`],
    workspaces: () => made.workspaces as Workspace[],
    addWorkspace: (folder, label) => void (made.workspaces as Workspace[]).push({ id: label.toLowerCase(), name: label, path: folder, dockUrl: "" }),
    live: () => made.live as LiveSession[],
    notify: (note) => void (made.notes as string[]).push(note.body),
    changed: () => undefined,
    log: (line) => void (made.logs as string[]).push(line),
  };
  const desk = new SyncDesk(dataRoot, host, () => new Date(), 1);
  const engine = await Syncthing.start({
    binary,
    home: desk.engineHome,
    listen: `tcp://127.0.0.1:${port}`,
    discovery: false,
    log: (line) => void (made.logs as string[]).push(line),
    onEvent: (event) => desk.onEvent(event),
    onExit: (why) => void (made.logs as string[]).push(why),
  });
  await desk.attach(engine);
  return Object.assign(made, { desk, engine }) as Machine;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, stdio: "pipe" }).toString().trim();
}

const read = (file: string) => fs.readFileSync(file, "utf8");
const copies = (dir: string): string[] => fs.readdirSync(dir, { recursive: true, encoding: "utf8" }).filter((name) => name.includes(".sync-conflict-") && !name.startsWith(`.git${path.sep}objects`));

describe.skipIf(!have)("workspace sync between two machines, with the real Syncthing", () => {
  let base = "";
  let a: Machine;
  let b: Machine;
  let folderId = "";
  let onA = "";
  let onB = "";

  beforeAll(async () => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), "vibeforge-sync-"));
    [a, b] = await Promise.all([machine("Desk", base), machine("Lap", base)]);
  }, 90_000);

  afterAll(async () => {
    await Promise.all([a?.engine.stop(), b?.engine.stop()]);
    a?.desk.detach();
    b?.desk.detach();
    fs.rmSync(base, { recursive: true, force: true });
  }, 60_000);

  it("pairs: one pastes the other's code, the other says yes", async () => {
    await expect(b.desk.addMachine("not a code")).rejects.toThrow(/not a sync code/);
    await expect(b.desk.addMachine(b.desk.code(b.engine.id))).rejects.toThrow(/own code/);
    await b.desk.addMachine(a.desk.code(a.engine.id));
    const asked = await until("the request on Desk", async () => (await a.desk.view()).requests.find((request) => request.id === b.engine.id));
    expect(asked.name).toBe("Lap");
    await until("the note about it", () => a.notes.some((note) => note.includes("Lap wants to sync")));
    await a.desk.acceptRequest(b.engine.id);
    await until("both connected", async () => (await a.desk.view()).machines[0]?.connected && (await b.desk.view()).machines[0]?.connected);
    // Each learns the other's name from the note they keep between them.
    await until("names", async () => (await b.desk.view()).machines[0]?.name === "Desk" && (await a.desk.view()).machines[0]?.name === "Lap");
    expect((await a.desk.view()).requests).toEqual([]);
  }, 120_000);

  it("shares a workspace: an offer on the other machine, taken up into a folder there", async () => {
    onA = path.join(a.home, "Projects", "site");
    fs.mkdirSync(path.join(onA, "node_modules", "pkg"), { recursive: true });
    fs.mkdirSync(path.join(onA, "src"), { recursive: true });
    fs.writeFileSync(path.join(onA, "node_modules", "pkg", "index.js"), "heavy\n");
    fs.writeFileSync(path.join(onA, "src", "app.ts"), "export const one = 1;\n");
    fs.writeFileSync(path.join(onA, "notes.txt"), "first\n");
    fs.writeFileSync(path.join(onA, ".gitignore"), "node_modules\nnotes.txt\n");
    git(onA, "init", "-q", "-b", "main");
    git(onA, "config", "user.name", "T");
    git(onA, "config", "user.email", "t@t.invalid");
    git(onA, "config", "commit.gpgsign", "false");
    git(onA, "add", "-A");
    git(onA, "commit", "-qm", "first");
    a.workspaces.push({ id: "site", name: "Site", path: onA, dockUrl: "" });

    await expect(a.desk.share("nope", b.engine.id, { mode: "two", filesOnly: false })).rejects.toThrow(/workspace is gone/);
    a.workspaces.push({ id: "home", name: "Home", path: a.home, dockUrl: "" });
    await expect(a.desk.share("home", b.engine.id, { mode: "two", filesOnly: false })).rejects.toThrow(/home folder/);
    await a.desk.share("site", b.engine.id, { mode: "two", filesOnly: false });
    await expect(a.desk.share("site", b.engine.id, { mode: "two", filesOnly: false })).rejects.toThrow(/already syncs/);
    expect((await a.desk.view()).shares[0]).toMatchObject({ workspaceId: "site", state: "offered", machineName: "Lap", mode: "two" });

    const offer = await until("the offer on Lap", async () => (await b.desk.view()).offers[0]);
    expect(offer).toMatchObject({ name: "Site", machineName: "Desk", mode: "two", filesOnly: false, suggestedPath: path.join(b.home, "Projects", "site"), suggestedHasFiles: false });
    await until("the note about it", () => b.notes.some((note) => note.includes("Desk wants to sync Site")));
    folderId = offer.folderId;
    onB = offer.suggestedPath;
    await b.desk.acceptOffer(folderId, onB);
    expect(b.workspaces.map((workspace) => workspace.path)).toEqual([onB]);

    await until("the files on Lap", () => fs.existsSync(path.join(onB, "src", "app.ts")) && fs.existsSync(path.join(onB, ".git", "HEAD")));
    await until("both synced", async () => (await a.desk.view()).shares[0]?.state === "synced" && (await b.desk.view()).shares[0]?.state === "synced");
    // What never syncs stayed behind, and git is the same repository there, clean.
    expect(fs.existsSync(path.join(onB, "node_modules"))).toBe(false);
    expect(git(onB, "log", "--format=%s")).toBe("first");
    expect(git(onB, "status", "--porcelain")).toBe("");
    expect(git(onB, "config", "core.checkStat")).toBe("minimal");
    expect(read(path.join(onB, ".stignore"))).toContain("(?d)node_modules");
  }, 120_000);

  it("says what is running in the workspace on the other machine", async () => {
    a.live.push({ ptyId: "p1", runId: null, kind: "shell", title: "Site", cwd: onA, pid: 1, startedAt: "", origin: null, agentId: null, chatId: null, taskId: null, workspaceId: "site", program: "Claude Code" });
    a.desk.setLive();
    await until("Lap seeing Claude Code on Desk", async () => (await b.desk.view()).shares[0]?.peerLive.includes("Claude Code"));
    a.live.length = 0;
    a.desk.setLive();
    await until("Lap seeing it gone", async () => (await b.desk.view()).shares[0]?.peerLive.length === 0);
  }, 60_000);

  it("keeps the losing version of a file both machines changed, and leaves no copy in the workspace", async () => {
    await a.engine.setPaused(b.engine.id, true);
    fs.writeFileSync(path.join(onA, "notes.txt"), "from Desk\n");
    await sleep(1200);
    fs.writeFileSync(path.join(onB, "notes.txt"), "from Lap, later\n");
    await sleep(2500);
    await a.engine.setPaused(b.engine.id, false);

    const waiting = await until("the conflict on Desk", async () => (await a.desk.view()).conflicts[0]);
    expect(waiting).toMatchObject({ kind: "file", path: "notes.txt", workspaceId: "site", machineName: "Lap" });
    expect((await a.desk.view()).shares[0].conflicts).toBe(1);
    await until("Lap's version in both", () => read(path.join(onA, "notes.txt")) === "from Lap, later\n" && read(path.join(onB, "notes.txt")) === "from Lap, later\n");
    expect(copies(onA)).toEqual([]);
    expect(copies(onB)).toEqual([]);
    expect((await b.desk.view()).conflicts).toEqual([]);
    expect(a.notes.some((note) => note.includes("notes.txt changed on both machines"))).toBe(true);

    const diff = await a.desk.conflictDiff(waiting.id);
    expect(diff).toContain("-from Lap, later");
    expect(diff).toContain("+from Desk");
    expect(diff).toContain("+++ b/notes.txt");

    await a.desk.resolveConflict(waiting.id, "mine");
    expect((await a.desk.view()).conflicts).toEqual([]);
    await until("Desk's version on Lap", () => read(path.join(onB, "notes.txt")) === "from Desk\n");
    expect(copies(onA)).toEqual([]);
    expect(copies(onB)).toEqual([]);
  }, 120_000);

  it("keeps this machine's commits on a branch when both committed while apart, and merges them", async () => {
    await until("settled", async () => (await a.desk.view()).shares[0]?.state === "synced" && (await b.desk.view()).shares[0]?.state === "synced");
    await a.engine.setPaused(b.engine.id, true);
    fs.writeFileSync(path.join(onA, "desk.txt"), "made on Desk\n");
    git(onA, "add", "desk.txt");
    git(onA, "commit", "-qm", "on Desk");
    const fromDesk = git(onA, "rev-parse", "HEAD");
    await sleep(1200);
    fs.writeFileSync(path.join(onB, "lap.txt"), "made on Lap\n");
    git(onB, "add", "lap.txt");
    git(onB, "commit", "-qm", "on Lap");
    const fromLap = git(onB, "rev-parse", "HEAD");
    await sleep(2500);
    await a.engine.setPaused(b.engine.id, false);

    const waiting = await until("the kept branch on Desk", async () => (await a.desk.view()).conflicts.find((conflict) => conflict.kind === "commits"));
    expect(waiting).toMatchObject({ path: "main", savedBranch: "main-from-desk", machineName: "Lap" });
    expect(git(onA, "rev-parse", "main")).toBe(fromLap);
    expect(git(onA, "rev-parse", "main-from-desk")).toBe(fromDesk);
    // The folder matches the branch: Desk's file went back into its commit, nothing else is left over.
    await until("a clean folder on Desk", () => git(onA, "status", "--porcelain") === "");
    expect(copies(onA)).toEqual([]);
    expect(a.notes.some((note) => note.includes("kept on main-from-desk"))).toBe(true);

    const merged = await a.desk.mergeConflict(waiting.id);
    expect(merged).toMatchObject({ merged: true, files: [] });
    expect((await a.desk.view()).conflicts).toEqual([]);
    await until("the merge on Lap", () => fs.existsSync(path.join(onB, "desk.txt")) && git(onB, "log", "-1", "--format=%P").split(" ").length === 2, 90_000);
    await until("clean on Lap", () => git(onB, "status", "--porcelain") === "");
    expect(git(onB, "fsck", "--no-dangling")).toBe("");
    expect(git(onA, "fsck", "--no-dangling")).toBe("");
    expect(copies(onB)).toEqual([]);
  }, 180_000);

  it("follows a change of mode, and a stop, on the other machine", async () => {
    await a.desk.updateShare(folderId, { mode: "send", filesOnly: false });
    await until("Lap receiving only", async () => (await b.desk.view()).shares[0]?.mode === "receive");
    expect((await a.desk.view()).shares[0].mode).toBe("send");

    await b.desk.stopShare(folderId);
    expect((await b.desk.view()).shares).toEqual([]);
    await until("Desk stopping too", async () => (await a.desk.view()).shares.length === 0);
    // The share is gone from the list a moment before its folder has been tidied.
    await a.desk.settled();
    expect(a.notes.some((note) => note.includes("Lap stopped syncing Site"))).toBe(true);
    // The files stay; Syncthing's marks go.
    for (const folder of [onA, onB]) {
      expect(fs.existsSync(path.join(folder, "src", "app.ts"))).toBe(true);
      expect(fs.existsSync(path.join(folder, ".stignore"))).toBe(false);
      expect(fs.existsSync(path.join(folder, ".stfolder"))).toBe(false);
    }
    // Stopped is not offered again.
    await sleep(1500);
    expect((await b.desk.view()).offers).toEqual([]);
    expect((await a.desk.view()).offers).toEqual([]);
  }, 120_000);

  it("unpairs", async () => {
    await a.desk.removeMachine(b.engine.id);
    expect((await a.desk.view()).machines).toEqual([]);
    expect((await a.engine.devices()).map((device) => device.id)).toEqual([a.engine.id]);
    expect((await a.engine.folders()).length).toBe(0);
  }, 60_000);
});
