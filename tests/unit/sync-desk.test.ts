import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SyncDesk, type SyncDeskHost } from "../../src/core/sync/desk.js";
import { linkFolderId, shortId } from "../../src/core/sync/protocol.js";
import type { EngineDevice, EngineFolder, EngineFolderStatus, SyncEngine } from "../../src/core/sync/types.js";
import type { LiveSession, Workspace } from "../../src/core/types.js";

// The desk with a stand-in engine: what it saves, what it asks of Syncthing, and how two desks
// follow each other through the note they keep between them (carried here by copying the files,
// which is what Syncthing does for real in sync-e2e.test.ts).

const A = "TIKSU4F-FTL4JMP-6WX2WN7-HAXB57C-6IVGIQ7-U7ZUQKP-KCA2BBD-D7RSEAV";
const B = "MTOM47S-JJWJ5ZV-ILPEULO-TWZVT4L-NH4YGIY-4FU5CNV-NOGQ3O6-VEV56AH";
const made: string[] = [];
const temp = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vibeforge-sync-desk-"));
  made.push(dir);
  return dir;
};
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

class FakeEngine implements SyncEngine {
  name = "";
  devicesNow: EngineDevice[] = [];
  foldersNow: EngineFolder[] = [];
  pending: Array<{ id: string; name: string; address: string }> = [];
  links: Record<string, { connected: boolean; address: string; lastSeen: string }> = {};
  status: Record<string, EngineFolderStatus> = {};
  scans: string[] = [];
  constructor(readonly id: string) {
    this.devicesNow.push({ id, name: "", addresses: ["dynamic"] });
  }
  async setName(name: string) {
    this.name = name;
  }
  async devices() {
    return structuredClone(this.devicesNow);
  }
  async putDevice(device: EngineDevice) {
    this.devicesNow = [...this.devicesNow.filter((item) => item.id !== device.id), device];
  }
  async removeDevice(id: string) {
    this.devicesNow = this.devicesNow.filter((item) => item.id !== id);
  }
  async pendingDevices() {
    return this.pending;
  }
  async dismissPendingDevice(id: string) {
    this.pending = this.pending.filter((item) => item.id !== id);
  }
  async folders() {
    return structuredClone(this.foldersNow);
  }
  async putFolder(folder: EngineFolder) {
    this.foldersNow = [...this.foldersNow.filter((item) => item.id !== folder.id), folder];
  }
  async removeFolder(id: string) {
    this.foldersNow = this.foldersNow.filter((item) => item.id !== id);
  }
  async connections() {
    return this.links;
  }
  async folderStatus(id: string) {
    return this.status[id] ?? { state: "idle", need: 0, errors: 0, localChanges: 0 };
  }
  async scan(folder: string, sub?: string) {
    this.scans.push(`${folder}:${sub ?? ""}`);
  }
  async revert() {}
}

interface Side {
  id: string;
  dataRoot: string;
  home: string;
  desk: SyncDesk;
  engine: FakeEngine;
  workspaces: Workspace[];
  live: LiveSession[];
  notes: string[];
  changes: number;
}

function side(id: string, name: string): Side {
  const made: Partial<Side> = { id, dataRoot: temp(), home: temp(), workspaces: [], live: [], notes: [], changes: 0 };
  const host: SyncDeskHost = {
    home: made.home as string,
    machineName: () => name,
    addresses: () => ["10.0.0.9:22737"],
    workspaces: () => made.workspaces as Workspace[],
    addWorkspace: (folder, label) => void (made.workspaces as Workspace[]).push({ id: `ws-${(made.workspaces as Workspace[]).length}`, name: label, path: folder, dockUrl: "" }),
    live: () => made.live as LiveSession[],
    notify: (note) => void (made.notes as string[]).push(note.body),
    changed: () => {
      (made as Side).changes += 1;
    },
    log: () => undefined,
  };
  made.desk = new SyncDesk(made.dataRoot as string, host);
  made.desk.unpairWaitMs = 0;
  made.engine = new FakeEngine(id);
  return made as Side;
}

/** What Syncthing does with the two machines' private folder: each one's note arrives at the other. */
async function carry(a: Side, b: Side): Promise<void> {
  await Promise.all([a.desk.settled(), b.desk.settled()]);
  const from = (one: Side, other: Side) => path.join(one.dataRoot, "sync", "link", shortId(other.id));
  for (const [one, other] of [
    [a, b],
    [b, a],
  ]) {
    const file = path.join(from(one, other), `${one.id}.json`);
    if (!fs.existsSync(file)) continue;
    fs.mkdirSync(from(other, one), { recursive: true });
    fs.copyFileSync(file, path.join(from(other, one), `${one.id}.json`));
    other.desk.onEvent({ type: "item-finished", folder: linkFolderId(a.id, b.id), item: `${one.id}.json`, action: "update", error: null });
  }
  await sleep(320);
  await Promise.all([a.desk.settled(), b.desk.settled()]);
}

async function paired(): Promise<{ a: Side; b: Side }> {
  const a = side(A, "Desk");
  const b = side(B, "Lap");
  await a.desk.attach(a.engine);
  await b.desk.attach(b.engine);
  await b.desk.addMachine(a.desk.code(A));
  a.engine.pending.push({ id: B, name: "Lap", address: "10.0.0.7:22737" });
  await a.desk.acceptRequest(B);
  for (const one of [a, b]) one.engine.links[one === a ? B : A] = { connected: true, address: "", lastSeen: "2026-11-17T12:00:00.000Z" };
  await carry(a, b);
  return { a, b };
}

function workspace(on: Side, name: string): Workspace {
  const folder = path.join(on.home, "Projects", name.toLowerCase());
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, "readme.md"), "hello\n");
  const made: Workspace = { id: name.toLowerCase(), name, path: folder, dockUrl: "" };
  on.workspaces.push(made);
  return made;
}

afterEach(() => {
  for (const dir of made.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("sync desk", () => {
  it("does nothing that needs the engine while sync is off", async () => {
    const a = side(A, "Desk");
    await expect(a.desk.addMachine(B)).rejects.toThrow("Sync is not running. Turn it on in Settings.");
    await expect(a.desk.share("x", B, { mode: "two", filesOnly: false })).rejects.toThrow(/not running/);
    expect(await a.desk.view()).toEqual({ machines: [], requests: [], offers: [], shares: [], conflicts: [] });
    expect(a.desk.engineHome).toBe(path.join(a.dataRoot, "sync", "engine"));
  });

  it("pairs two machines and gives them their private folder", async () => {
    const { a, b } = await paired();
    expect(a.engine.name).toBe("Desk");
    // Lap pasted Desk's code, with where Desk can be reached; Desk learned Lap's address from its request.
    expect(b.engine.devicesNow.find((device) => device.id === A)).toEqual({ id: A, name: "Desk", addresses: ["dynamic", "tcp://10.0.0.9:22737"] });
    expect(a.engine.devicesNow.find((device) => device.id === B)).toEqual({ id: B, name: "Lap", addresses: ["dynamic", "tcp://10.0.0.7:22737"] });
    const link = linkFolderId(A, B);
    for (const one of [a, b]) {
      expect(one.engine.foldersNow).toEqual([{ id: link, label: "VibeForge link", path: path.join(one.dataRoot, "sync", "link", shortId(one === a ? B : A)), type: "sendreceive", devices: [one === a ? B : A], watchDelay: 1 }]);
    }
    expect((await a.desk.view()).machines).toEqual([{ id: B, name: "Lap", connected: true, lastSeen: "2026-11-17T12:00:00.000Z" }]);
    expect((await b.desk.view()).machines[0]).toMatchObject({ name: "Desk", connected: true });
    // Pasting the same code again only refreshes it.
    await b.desk.addMachine(`${A}@10.0.0.50`);
    expect(b.engine.devicesNow.find((device) => device.id === A)?.addresses).toEqual(["dynamic", "tcp://10.0.0.50:22737", "tcp://10.0.0.9:22737"]);
    await expect(a.desk.addMachine(A)).rejects.toThrow(/own code/);
    await expect(a.desk.acceptRequest(B)).rejects.toThrow(/no longer asking/);
  });

  it("asks once about a machine that wants to pair, and can say not now", async () => {
    const a = side(A, "Desk");
    await a.desk.attach(a.engine);
    a.engine.pending.push({ id: B, name: "Lap", address: "[fd7a::2]:40000" });
    a.desk.onEvent({ type: "pending-devices" });
    a.desk.onEvent({ type: "pending-devices" });
    await sleep(300);
    await a.desk.settled();
    expect(a.notes).toEqual(["Lap wants to sync with this machine. Answer in Settings, under Sync."]);
    expect((await a.desk.view()).requests).toEqual([{ id: B, name: "Lap", address: "[fd7a::2]:40000" }]);
    await a.desk.ignoreRequest(B);
    expect((await a.desk.view()).requests).toEqual([]);
    // Asked again after a not-now: still quiet, until its code is pasted here.
    a.engine.pending.push({ id: B, name: "Lap", address: "[fd7a::2]:40000" });
    expect((await a.desk.view()).requests).toEqual([]);
    await a.desk.addMachine(B);
    expect((await a.desk.view()).machines.map((machine) => machine.id)).toEqual([B]);
    // An address it dialled from a throwaway port is kept with sync's own port: here, none was learned.
    expect(a.engine.devicesNow.find((device) => device.id === B)?.addresses).toEqual(["dynamic"]);
  });

  it("shares a workspace, which the other machine is offered and takes up", async () => {
    const { a, b } = await paired();
    const site = workspace(a, "Site");
    await a.desk.share(site.id, B, { mode: "send", filesOnly: false });
    const share = (await a.desk.view()).shares[0];
    expect(share).toMatchObject({ workspaceId: "site", path: site.path, machineId: B, machineName: "Lap", mode: "send", filesOnly: false, state: "offered", conflicts: 0, peerLive: [] });
    expect(a.engine.foldersNow.find((folder) => folder.id === share.folderId)).toEqual({ id: share.folderId, label: "Site", path: site.path, type: "sendonly", devices: [B], watchDelay: 5 });
    expect(fs.readFileSync(path.join(site.path, ".stignore"), "utf8")).toContain("(?d)node_modules");

    await carry(a, b);
    const offer = (await b.desk.view()).offers[0];
    expect(offer).toEqual({ folderId: share.folderId, machineId: A, machineName: "Desk", name: "Site", mode: "receive", filesOnly: false, suggestedPath: path.join(b.home, "Projects", "site"), suggestedHasFiles: false });
    expect(b.notes).toEqual(["Desk wants to sync Site with this machine. Answer in Code, above the workspaces."]);
    await carry(a, b);
    expect(b.notes).toHaveLength(1);

    await expect(b.desk.acceptOffer(share.folderId, "relative")).rejects.toThrow(/folder that exists/);
    await expect(b.desk.acceptOffer(share.folderId, b.home)).rejects.toThrow(/home folder/);
    await expect(b.desk.acceptOffer("vf-ws-000000000000", offer.suggestedPath)).rejects.toThrow(/offer is gone/);
    await b.desk.acceptOffer(share.folderId, offer.suggestedPath);
    expect(b.workspaces).toEqual([{ id: "ws-0", name: "Site", path: offer.suggestedPath, dockUrl: "" }]);
    expect(b.engine.foldersNow.find((folder) => folder.id === share.folderId)).toMatchObject({ path: offer.suggestedPath, type: "receiveonly", devices: [A] });
    expect((await b.desk.view()).offers).toEqual([]);
    expect((await b.desk.view()).shares[0]).toMatchObject({ workspaceId: "ws-0", mode: "receive", state: "synced" });

    // Desk sees it taken up once Lap's note arrives; then the state follows the engine.
    await carry(a, b);
    expect((await a.desk.view()).shares[0].state).toBe("synced");
    a.engine.status[share.folderId] = { state: "syncing", need: 3, errors: 0, localChanges: 0 };
    expect((await a.desk.view()).shares[0]).toMatchObject({ state: "syncing", need: 3 });
    a.engine.status[share.folderId] = { state: "idle", need: 0, errors: 2, localChanges: 0 };
    expect((await a.desk.view()).shares[0].state).toBe("error");
    a.engine.status[share.folderId] = { state: "idle", need: 0, errors: 0, localChanges: 0 };
    a.engine.links[B].connected = false;
    expect((await a.desk.view()).shares[0].state).toBe("away");
  });

  it("refuses folders that can't sync on their own", async () => {
    const { a } = await paired();
    const site = workspace(a, "Site");
    await a.desk.share(site.id, B, { mode: "two", filesOnly: false });
    await expect(a.desk.share(site.id, B, { mode: "two", filesOnly: false })).rejects.toThrow("This folder already syncs with a machine.");
    fs.mkdirSync(path.join(site.path, "packages", "ui"), { recursive: true });
    a.workspaces.push({ id: "ui", name: "UI", path: path.join(site.path, "packages", "ui"), dockUrl: "" }, { id: "projects", name: "Projects", path: path.dirname(site.path), dockUrl: "" }, { id: "gone", name: "Gone", path: path.join(a.home, "nowhere"), dockUrl: "" });
    await expect(a.desk.share("ui", B, { mode: "two", filesOnly: false })).rejects.toThrow(/inside another synced folder/);
    await expect(a.desk.share("projects", B, { mode: "two", filesOnly: false })).rejects.toThrow(/inside another synced folder/);
    await expect(a.desk.share("gone", B, { mode: "two", filesOnly: false })).rejects.toThrow(/does not exist/);
    await expect(a.desk.share("nope", B, { mode: "two", filesOnly: false })).rejects.toThrow(/workspace is gone/);
    await expect(a.desk.share("ui", A, { mode: "two", filesOnly: false })).rejects.toThrow(/not paired/);
    await expect(a.desk.updateShare("vf-ws-000000000000", { mode: "two", filesOnly: false })).rejects.toThrow(/no longer syncs/);
  });

  it("won't sync a folder that holds other workspaces, shared or not (decision D2)", async () => {
    const { a } = await paired();
    const site = workspace(a, "Site");
    a.workspaces.push({ id: "projects", name: "Projects", path: path.dirname(site.path), dockUrl: "" });
    await expect(a.desk.share("projects", B, { mode: "two", filesOnly: false })).rejects.toThrow(/holds other workspaces \(Site\)/);
  });

  it("sends only the files of a branch opened beside its repository", async () => {
    const { a } = await paired();
    const branch = workspace(a, "Branch");
    fs.writeFileSync(path.join(branch.path, ".git"), "gitdir: /elsewhere/.git/worktrees/branch\n");
    await a.desk.share(branch.id, B, { mode: "two", filesOnly: false });
    expect((await a.desk.view()).shares[0].filesOnly).toBe(true);
    expect(fs.readFileSync(path.join(branch.path, ".stignore"), "utf8")).toContain("(?d).git");
  });

  it("follows a change of direction, tells what runs here, and ends on both machines", async () => {
    const { a, b } = await paired();
    const site = workspace(a, "Site");
    await a.desk.share(site.id, B, { mode: "two", filesOnly: false });
    await carry(a, b);
    const { folderId, suggestedPath } = (await b.desk.view()).offers[0];
    await b.desk.acceptOffer(folderId, suggestedPath);
    await carry(a, b);

    await b.desk.updateShare(folderId, { mode: "send", filesOnly: true });
    expect(b.engine.foldersNow.find((folder) => folder.id === folderId)?.type).toBe("sendonly");
    await carry(a, b);
    expect((await a.desk.view()).shares[0]).toMatchObject({ mode: "receive", filesOnly: true });
    expect(a.engine.foldersNow.find((folder) => folder.id === folderId)?.type).toBe("receiveonly");
    expect(fs.readFileSync(path.join(site.path, ".stignore"), "utf8")).toContain("(?d).git");
    // Saving the same thing again is no change.
    await b.desk.updateShare(folderId, { mode: "send", filesOnly: true });

    // A CLI in the workspace on Desk shows on Lap.
    a.live.push({ ptyId: "p", runId: null, kind: "shell", title: "Site", cwd: site.path, pid: 1, startedAt: "", origin: null, agentId: null, chatId: null, taskId: null, workspaceId: "site", program: "Claude Code" });
    a.live.push({ ptyId: "q", runId: null, kind: "shell", title: "Site", cwd: path.join(site.path, "src"), pid: 2, startedAt: "", origin: null, agentId: null, chatId: null, taskId: null, workspaceId: "site" });
    a.live.push({ ptyId: "r", runId: null, kind: "shell", title: "Other", cwd: a.home, pid: 3, startedAt: "", origin: null, agentId: null, chatId: null, taskId: null, workspaceId: null });
    a.desk.setLive();
    a.desk.setLive();
    await carry(a, b);
    expect((await b.desk.view()).shares[0].peerLive).toEqual(["Claude Code", "Shell"]);

    // Lap stops: its folder goes at once, Desk's when the note arrives; the files stay on both.
    fs.mkdirSync(path.join(suggestedPath, ".stfolder"));
    fs.appendFileSync(path.join(suggestedPath, ".stignore"), "*.log\n");
    await b.desk.stopShare(folderId);
    expect((await b.desk.view()).shares).toEqual([]);
    expect(b.engine.foldersNow.map((folder) => folder.id)).toEqual([linkFolderId(A, B)]);
    expect(fs.existsSync(path.join(suggestedPath, ".stfolder"))).toBe(false);
    expect(fs.readFileSync(path.join(suggestedPath, ".stignore"), "utf8")).toBe("*.log\n");
    await carry(a, b);
    expect((await a.desk.view()).shares).toEqual([]);
    expect(a.notes.at(-1)).toBe("Lap stopped syncing Site. Its files stay on this machine.");
    expect(fs.existsSync(path.join(site.path, ".stignore"))).toBe(false);
    expect(fs.readFileSync(path.join(site.path, "readme.md"), "utf8")).toBe("hello\n");
    // Not offered back to either, and stopping twice is nothing.
    await carry(a, b);
    expect((await b.desk.view()).offers).toEqual([]);
    expect((await a.desk.view()).offers).toEqual([]);
    await b.desk.stopShare(folderId);
  });

  it("drops an offer that was declined", async () => {
    const { a, b } = await paired();
    const site = workspace(a, "Site");
    await a.desk.share(site.id, B, { mode: "two", filesOnly: false });
    await carry(a, b);
    const { folderId } = (await b.desk.view()).offers[0];
    await b.desk.declineOffer(folderId);
    await b.desk.declineOffer(folderId);
    expect((await b.desk.view()).offers).toEqual([]);
    await carry(a, b);
    expect((await a.desk.view()).shares).toEqual([]);
    await carry(a, b);
    expect((await b.desk.view()).offers).toEqual([]);
  });

  it("takes in a copy of a file both machines changed as its files arrive", async () => {
    const { a, b } = await paired();
    const site = workspace(a, "Site");
    await a.desk.share(site.id, B, { mode: "two", filesOnly: false });
    await carry(a, b);
    const folderId = (await a.desk.view()).shares[0].folderId;
    fs.writeFileSync(path.join(site.path, `readme.sync-conflict-20261117-204452-${shortId(B)}.md`), "this machine's\n");
    a.desk.onEvent({ type: "item-finished", folder: folderId, item: "readme.md", action: "update", error: null });
    a.desk.onEvent({ type: "item-finished", folder: folderId, item: ".git/index", action: "update", error: null });
    a.desk.onEvent({ type: "item-finished", folder: "someone-else's", item: "x", action: "update", error: null });
    await sleep(1800);
    await a.desk.settled();
    const view = await a.desk.view();
    expect(view.conflicts).toEqual([expect.objectContaining({ folderId, workspaceId: "site", kind: "file", path: "readme.md", machineName: "Lap", savedBranch: null })]);
    expect(view.shares[0].conflicts).toBe(1);
    expect(fs.readdirSync(site.path).filter((name) => name.includes("sync-conflict"))).toEqual([]);
    expect(a.notes.at(-1)).toBe("readme.md changed on both machines. Lap's version is in the workspace; this machine's is kept safe.");
    expect(await a.desk.conflictDiff(view.conflicts[0].id)).toContain("+this machine's");

    await a.desk.resolveConflict(view.conflicts[0].id, "mine");
    expect(fs.readFileSync(path.join(site.path, "readme.md"), "utf8")).toBe("this machine's\n");
    expect(a.engine.scans).toEqual([`${folderId}:readme.md`]);
    expect((await a.desk.view()).conflicts).toEqual([]);
    await expect(a.desk.mergeConflict("nope")).rejects.toThrow(/no longer waiting/);
  });

  it("finds copies made while it wasn't running, says when a folder is gone, and unpairs cleanly", async () => {
    const { a } = await paired();
    const site = workspace(a, "Site");
    await a.desk.share(site.id, B, { mode: "two", filesOnly: false });
    a.desk.detach();
    fs.writeFileSync(path.join(site.path, `readme.sync-conflict-20261117-204452-${shortId(B)}.md`), "made while off\n");
    // Stopping a share while sync is off still tidies the folder later; here it is still shared.
    await a.desk.attach(a.engine);
    expect((await a.desk.view()).conflicts).toHaveLength(1);

    fs.rmSync(site.path, { recursive: true });
    a.desk.detach();
    await a.desk.attach(a.engine);
    expect((await a.desk.view()).shares[0].state).toBe("error");

    await a.desk.removeMachine(B);
    // It dialling in again in the next minutes is not a new request: it hasn't heard yet.
    a.engine.pending.push({ id: B, name: "Lap", address: "10.0.0.7:22737" });
    expect(await a.desk.view()).toEqual({ machines: [], requests: [], offers: [], shares: [], conflicts: [] });
    expect(a.engine.pending).toEqual([]);
    expect(a.engine.devicesNow.map((device) => device.id)).toEqual([A]);
    expect(a.engine.foldersNow).toEqual([]);
    expect(fs.existsSync(path.join(a.dataRoot, "sync", "link", shortId(B)))).toBe(false);
  });

  it("stops a share while sync is off, tidying the folder itself", async () => {
    const { a } = await paired();
    const site = workspace(a, "Site");
    await a.desk.share(site.id, B, { mode: "two", filesOnly: false });
    const folderId = (await a.desk.view()).shares[0].folderId;
    a.desk.detach();
    await a.desk.stopShare(folderId);
    expect(fs.existsSync(path.join(site.path, ".stignore"))).toBe(false);
    expect((await a.desk.view()).shares).toEqual([]);
  });

  it.skipIf(process.getuid?.() === 0)("keeps syncing the other workspaces when one's folder can't be written", async () => {
    const { a } = await paired();
    const site = workspace(a, "Site");
    const docs = workspace(a, "Docs");
    await a.desk.share(site.id, B, { mode: "two", filesOnly: false });
    // Its ignore file gone and the folder read-only (a read-only mount, a permissions mistake).
    fs.rmSync(path.join(site.path, ".stignore"));
    fs.chmodSync(site.path, 0o555);
    try {
      await a.desk.share(docs.id, B, { mode: "two", filesOnly: false });
      a.desk.detach();
      await a.desk.attach(a.engine);
      const shares = (await a.desk.view()).shares;
      expect(shares.find((share) => share.workspaceId === "site")?.state).toBe("error");
      expect(shares.find((share) => share.workspaceId === "docs")?.state).not.toBe("error");
      // Not handed to Syncthing without its ignore lines; the other one is.
      expect(a.engine.foldersNow.map((folder) => folder.path)).toEqual([path.join(a.dataRoot, "sync", "link", shortId(B)), docs.path]);
    } finally {
      fs.chmodSync(site.path, 0o755);
    }
    // Writable again: it syncs again at the next look.
    a.desk.detach();
    await a.desk.attach(a.engine);
    expect(fs.readFileSync(path.join(site.path, ".stignore"), "utf8")).toContain("(?d)node_modules");
    expect(a.engine.foldersNow.map((folder) => folder.path).sort()).toEqual([path.join(a.dataRoot, "sync", "link", shortId(B)), docs.path, site.path].sort());
  });

  it("unpairs the other machine too, with a last note", async () => {
    const { a, b } = await paired();
    const site = workspace(a, "Site");
    await a.desk.share(site.id, B, { mode: "two", filesOnly: false });
    await carry(a, b);
    const { folderId, suggestedPath } = (await b.desk.view()).offers[0];
    await b.desk.acceptOffer(folderId, suggestedPath);
    await carry(a, b);
    // Desk unpairs. Its last note is carried over before its folder goes (Syncthing does that in the moment it waits).
    const note = path.join(a.dataRoot, "sync", "link", shortId(B), `${A}.json`);
    a.desk.unpairWaitMs = 400;
    const unpairing = a.desk.removeMachine(B);
    await sleep(150);
    fs.copyFileSync(note, path.join(b.dataRoot, "sync", "link", shortId(A), `${A}.json`));
    b.desk.onEvent({ type: "item-finished", folder: linkFolderId(A, B), item: `${A}.json`, action: "update", error: null });
    await unpairing;
    await sleep(320);
    await b.desk.settled();
    expect(await b.desk.view()).toEqual({ machines: [], requests: [], offers: [], shares: [], conflicts: [] });
    expect(b.notes.at(-1)).toBe("Desk unpaired from this machine. What synced with it has stopped; the files stay.");
    expect(b.engine.devicesNow.map((device) => device.id)).toEqual([B]);
    expect(b.engine.foldersNow).toEqual([]);
    expect(fs.existsSync(path.join(suggestedPath, ".stignore"))).toBe(false);
    expect(await a.desk.view()).toEqual({ machines: [], requests: [], offers: [], shares: [], conflicts: [] });
  });

  it("waits to run git rescue until Syncthing reports the folder idle with nothing needed", async () => {
    const { execFileSync } = await import("node:child_process");
    const { a, b } = await paired();
    const site = workspace(a, "Site");
    const git = (...args: string[]) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd: site.path, stdio: "pipe" }).toString().trim();
    git("init", "-q", "-b", "main");
    git("add", "-A");
    git("commit", "-qm", "base");
    const mine = git("rev-parse", "HEAD");
    git("commit", "-qm", "theirs", "--allow-empty");
    const conflict = path.join(site.path, ".git", "refs", "heads", `main.sync-conflict-20261117-204452-${shortId(B)}`);
    fs.writeFileSync(conflict, `${mine}\n`);

    await a.desk.share(site.id, B, { mode: "two", filesOnly: false });
    await carry(a, b);
    const folderId = (await a.desk.view()).shares[0].folderId;

    a.engine.status[folderId] = { state: "syncing", need: 4, errors: 0, localChanges: 0 };
    a.desk.onEvent({ type: "item-finished", folder: folderId, item: ".git/refs/heads/main", action: "update", error: null });
    await sleep(1700);
    await a.desk.settled();
    expect(fs.existsSync(conflict)).toBe(true);

    a.engine.status[folderId] = { state: "idle", need: 0, errors: 0, localChanges: 0 };
    a.desk.onEvent({ type: "folder-state", folder: folderId, state: "idle" });
    await sleep(1700);
    await a.desk.settled();
    expect(fs.existsSync(conflict)).toBe(false);
  });

  it("ignores removeMachine for invalid or unknown ids, and drops dot-directory offer hints", async () => {
    const { a } = await paired();
    const marker = path.join(a.dataRoot, "keep-me.txt");
    fs.writeFileSync(marker, "keep");
    await a.desk.removeMachine("../..");
    await a.desk.removeMachine("AAAAAAA-AAAAAAA-AAAAAAA-AAAAAAA-AAAAAAA-AAAAAAA-AAAAAAA-AAAAAAA");
    expect(fs.existsSync(marker)).toBe(true);
    expect(fs.existsSync(path.join(a.dataRoot, "sync", "link", shortId(B)))).toBe(true);

    const { readLink, homeHint } = await import("../../src/core/sync/link.js");
    expect(homeHint(path.join(a.home, ".ssh"), a.home)).toBe("");
    const linkFile = path.join(a.dataRoot, "sync", "link", shortId(B), `${B}.json`);
    fs.mkdirSync(path.dirname(linkFile), { recursive: true });
    fs.writeFileSync(
      linkFile,
      JSON.stringify({
        v: 1,
        id: B,
        name: "Lap",
        shares: {
          "vf-ws-111111": { name: "Keys", mode: "two", filesOnly: false, hint: ".ssh/authorized", rev: 1 },
          "vf-ws-222222": { name: "Nested", mode: "two", filesOnly: false, hint: "Projects/.config", rev: 1 },
        },
        stopped: [],
        live: {},
      }),
    );
    const parsed = readLink(linkFile, B);
    expect(parsed?.shares["vf-ws-111111"].hint).toBe("");
    expect(parsed?.shares["vf-ws-222222"].hint).toBe("");
    a.desk.onEvent({ type: "item-finished", folder: linkFolderId(A, B), item: `${B}.json`, action: "update", error: null });
    await sleep(300);
    await a.desk.settled();
    const view = await a.desk.view();
    expect(view.offers.find((item) => item.folderId === "vf-ws-111111")?.suggestedPath).toBe(path.join(a.home, "Projects", "Keys"));
  });

  it("refuses hidden dot-directories inside the home folder", async () => {
    const { a } = await paired();
    const ssh = path.join(a.home, ".ssh");
    const nvim = path.join(a.home, ".config", "nvim");
    fs.mkdirSync(ssh, { recursive: true });
    fs.mkdirSync(nvim, { recursive: true });
    a.workspaces.push({ id: "ssh", name: "SSH", path: ssh, dockUrl: "" }, { id: "nvim", name: "Nvim", path: nvim, dockUrl: "" });
    await expect(a.desk.share("ssh", B, { mode: "two", filesOnly: false })).rejects.toThrow(/hidden folder/i);
    await expect(a.desk.share("nvim", B, { mode: "two", filesOnly: false })).rejects.toThrow(/hidden folder/i);
  });
});
