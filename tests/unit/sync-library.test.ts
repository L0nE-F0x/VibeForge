import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Store } from "../../src/core/store.js";
import { ConflictStore } from "../../src/core/sync/conflicts.js";
import { DELETE_GRACE_MS, LibrarySync, readRecord, type LibraryHost } from "../../src/core/sync/library.js";
import { compareClocks, diff3, mergeSet, mergeText } from "../../src/core/sync/library-merge.js";
import { pickEngine, placeKey, portablePlace, readPlace, resolvePlace, type LocalEngine } from "../../src/core/sync/places-match.js";
import { shortId } from "../../src/core/sync/protocol.js";
import type { Agent, Workspace } from "../../src/core/types.js";

// Synced agents and skills: the merge rules on their own, folders and CLIs found again on another
// machine, and two machines' libraries following each other through the files each writes for the
// other (carried here by copying, which is what Syncthing does in sync-e2e.test.ts).

const A = "TIKSU4F-FTL4JMP-6WX2WN7-HAXB57C-6IVGIQ7-U7ZUQKP-KCA2BBD-D7RSEAV";
const B = "MTOM47S-JJWJ5ZV-ILPEULO-TWZVT4L-NH4YGIY-4FU5CNV-NOGQ3O6-VEV56AH";
const made: string[] = [];
const temp = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vibeforge-sync-library-"));
  made.push(dir);
  return dir;
};

afterEach(() => {
  for (const dir of made.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("merging", () => {
  it("orders clocks", () => {
    expect(compareClocks({ A: 1 }, { A: 1 })).toBe("same");
    expect(compareClocks({ A: 1 }, { A: 2 })).toBe("before");
    expect(compareClocks({ A: 2, B: 1 }, { A: 2 })).toBe("after");
    expect(compareClocks({ A: 2 }, { A: 1, B: 1 })).toBe("apart");
  });

  it("merges lines changed in different places and keeps both additions at the same place", () => {
    expect(diff3(["a", "b", "c", "d"], ["a", "B", "c", "d"], ["a", "b", "c", "D"])).toEqual([{ ok: ["a", "B", "c", "D"] }]);
    // Neighbouring lines changed on each side are one clash, as in git.
    expect(diff3(["a", "b", "c"], ["a", "B", "c"], ["a", "b", "C"])).toEqual([{ ok: ["a"] }, { conflict: { base: ["b", "c"], ours: ["B", "c"], theirs: ["b", "C"] } }]);
    const both = mergeText("- one", { text: "- one\n- laptop", at: "2026-11-21T10:00:00Z", by: "AAAAAAA" }, { text: "- one\n- desktop", at: "2026-11-21T11:00:00Z", by: "BBBBBBB" }, "later");
    expect(both).toMatchObject({ text: "- one\n- laptop\n- desktop", clashed: false, oursLost: false, theirsLost: false });
  });

  it("gives the same answer on either machine", () => {
    const base = "Be careful.\nRun the tests.";
    const one = { text: "Be very careful.\nRun the tests.", at: "2026-11-21T10:00:00Z", by: "AAAAAAA" };
    const two = { text: "Be quick.\nRun the tests.", at: "2026-11-21T11:00:00Z", by: "BBBBBBB" };
    const here = mergeText(base, one, two, "later");
    const there = mergeText(base, two, one, "later");
    expect(here.text).toBe(there.text);
    expect(here.text).toBe("Be quick.\nRun the tests.");
    expect(here.oursLost).toBe(true);
    expect(there.theirsLost).toBe(true);
    // Memory loses nothing: both lines stay.
    expect(mergeText(base, one, two, "union").text).toBe("Be very careful.\nBe quick.\nRun the tests.");
  });

  it("keeps what either side added to a set and drops what one removed", () => {
    const merged = mergeSet(["a", "b"], { items: ["a", "c"], at: "1", by: "AAAAAAA" }, { items: ["a", "b", "d"], at: "2", by: "BBBBBBB" }, String);
    expect(merged.sort()).toEqual(["a", "c", "d"]);
  });
});

describe("folders and CLIs on another machine", () => {
  it("sends a folder as its workspace and finds it by name, by synced id, or under home", () => {
    const home = temp();
    const site = path.join(home, "Projects", "site");
    fs.mkdirSync(path.join(site, "docs"), { recursive: true });
    const context = { home, workspaces: [{ name: "Site", path: site }], shares: [] };
    const place = portablePlace(path.join(site, "docs"), context);
    expect(place).toEqual({ key: "name:site:docs", workspace: "Site", folderId: "", sub: "docs", hint: "Projects/site/docs" });
    // Elsewhere, under another folder, the same workspace name.
    const otherHome = temp();
    const there = path.join(otherHome, "code", "site");
    fs.mkdirSync(path.join(there, "docs"), { recursive: true });
    expect(resolvePlace(place!, { home: otherHome, workspaces: [{ name: "site", path: there }], shares: [] })).toBe(path.join(there, "docs"));
    // A synced workspace goes by its id, whatever it is called.
    const shared = portablePlace(site, { ...context, shares: [{ folderId: "vf-ws-0123456789ab", path: site }] });
    expect(shared?.key).toBe("ws:vf-ws-0123456789ab:");
    expect(resolvePlace(shared!, { home: otherHome, workspaces: [], shares: [{ folderId: "vf-ws-0123456789ab", path: there }] })).toBe(there);
    // Nothing of that name here: not found.
    expect(resolvePlace(place!, { home: otherHome, workspaces: [], shares: [] })).toBeNull();
    // Outside home and every workspace: can't be told.
    expect(portablePlace("/opt/thing", context)).toBeNull();
  });

  it("never takes a path that leaves home or enters a dot-folder", () => {
    expect(readPlace({ workspace: "", hint: "../../etc" })).toBeNull();
    expect(readPlace({ hint: ".ssh" })).toBeNull();
    expect(readPlace({ workspace: "site", sub: "../x", hint: "/etc" })).toEqual({ key: placeKey({ workspace: "site", folderId: "", sub: "", hint: "" }), workspace: "site", folderId: "", sub: "", hint: "" });
  });

  it("falls back to the same command, then the default, then any installed CLI", () => {
    const engines: LocalEngine[] = [
      { id: "claude", label: "Claude Code", bin: "claude", available: true },
      { id: "grok", label: "Grok Build", bin: "grok", available: false },
      { id: "my-grok", label: "Grok (mine)", bin: "/opt/bin/grok", available: true },
      { id: "kimi", label: "Kimi", bin: "kimi", available: true },
    ];
    expect(pickEngine({ id: "claude", label: "", bin: "claude" }, engines, "kimi")).toBe("claude");
    expect(pickEngine({ id: "grok", label: "", bin: "grok" }, engines, "claude")).toBe("my-grok");
    expect(pickEngine({ id: "codex", label: "", bin: "codex" }, engines, "kimi")).toBe("kimi");
    expect(pickEngine({ id: "codex", label: "", bin: "codex" }, engines, "gone")).toBe("claude");
    expect(pickEngine({ id: "codex", label: "", bin: "codex" }, [], "claude")).toBe("codex");
  });
});

// ------------------------------------------------------------------ two machines

interface Machine {
  id: string;
  name: string;
  home: string;
  data: string;
  store: Store;
  lib: LibrarySync;
  workspaces: Workspace[];
  engines: LocalEngine[];
  arrived: string[];
  conflicts: ConflictStore;
}

let clock = Date.parse("2026-11-21T09:00:00Z");
const now = () => {
  clock += 1000;
  return new Date(clock);
};

function machine(id: string, name: string): Machine {
  const home = temp();
  const data = temp();
  const config = temp();
  const store = new Store(config, data);
  const m = { id, name, home, data, store, workspaces: [] as Workspace[], engines: [{ id: "claude", label: "Claude Code", bin: "claude", available: true }] as LocalEngine[], arrived: [] as string[] } as Machine;
  const host: LibraryHost = {
    agents: () => store.listAgents(),
    // As electron/sync.ts: one that is there but can't be read throws, rather than passing for deleted.
    getAgent: (agentId) => store.readAgent(agentId),
    saveAgent: (agent) => store.writeAgent(agent),
    readMemory: (agentId) => store.readMemory(agentId),
    writeMemory: (agentId, text) => store.writeMemory(agentId, text),
    skills: () => store.listSkills(),
    getSkill: (skillId) => store.readSkill(skillId),
    saveSkill: (skill) => store.writeSkill(skill),
    newId: (kind, label) => store.uniqueId(path.join(config, kind === "agent" ? "agents" : "skills"), label, ""),
    remove: async (kind, itemId) => fs.rmSync(path.join(config, kind === "agent" ? "agents" : "skills", itemId), { recursive: true, force: true }),
    engines: () => m.engines,
    defaultEngine: () => "claude",
    arrived: (kind, label, from) => void m.arrived.push(`${kind}:${label}:${from}`),
    changed: () => undefined,
    log: () => undefined,
  };
  m.conflicts = new ConflictStore(path.join(data, "sync", "conflicts"), now);
  m.lib = new LibrarySync(data, host, m.conflicts, now);
  m.lib.setMe(shortId(id));
  return m;
}

const linkDir = (m: Machine, other: Machine) => path.join(m.data, "sync", "link", shortId(other.id));

async function pass(m: Machine, other: Machine): Promise<void> {
  m.lib.setPlaces({ home: m.home, workspaces: m.workspaces, shares: [] });
  await m.lib.receive([{ id: other.id, name: other.name, dir: linkDir(m, other) }]);
  m.lib.scan();
  m.lib.publish(m.id, [{ id: other.id, name: other.name, dir: linkDir(m, other) }]);
}

/** What Syncthing does: each machine's files arrive at the other. */
function carry(from: Machine, to: Machine): void {
  const source = path.join(linkDir(from, to), "library", from.id);
  if (!fs.existsSync(source)) return;
  const target = path.join(linkDir(to, from), "library", from.id);
  fs.rmSync(target, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.cpSync(source, target, { recursive: true });
}

/** Until both have said all they have to say. */
async function settle(a: Machine, b: Machine): Promise<void> {
  for (let round = 0; round < 6; round += 1) {
    await pass(a, b);
    carry(a, b);
    await pass(b, a);
    carry(b, a);
  }
}

function workspace(m: Machine, name: string, folder = path.join(m.home, "Projects", name)): string {
  fs.mkdirSync(folder, { recursive: true });
  m.workspaces.push({ id: name.toLowerCase(), name, path: folder, dockUrl: "" });
  return folder;
}

function agent(m: Machine, patch: Partial<Agent> & { name: string }): Agent {
  const value: Agent = { id: patch.name.toLowerCase(), engine: "claude", brief: "Review the change.", memoryFile: "memory.md", places: [], skills: [], allowRoutines: true, goodAt: "", tier: "", createdAt: "2026-11-01T00:00:00Z", updatedAt: "2026-11-01T00:00:00Z", ...patch };
  m.store.writeAgent(value);
  return value;
}

const turnOn = (m: Machine, kind: "agent" | "skill", id: string) => {
  m.lib.setPlaces({ home: m.home, workspaces: m.workspaces, shares: [] });
  m.lib.setOn(kind, id, true);
};

describe("two machines", () => {
  it("brings an agent turned on, with its skills, memory and folders matched by workspace name", async () => {
    const a = machine(A, "Laptop");
    const b = machine(B, "Desktop");
    const site = workspace(a, "Site");
    a.store.writeSkill({ id: "tests", name: "Tests", description: "Runs them", body: "Run npm test." });
    agent(a, { name: "Reviewer", places: [site], skills: ["tests"], goodAt: "reviews" });
    a.store.writeMemory("reviewer", "- 2026-11-20 prefers small PRs\n");
    const thereSite = workspace(b, "site", path.join(b.home, "code", "site"));
    turnOn(a, "agent", "reviewer");
    await settle(a, b);
    const got = b.store.getAgent("reviewer");
    expect(got).toMatchObject({ name: "Reviewer", brief: "Review the change.", places: [thereSite], skills: ["tests"], goodAt: "reviews", engine: "claude" });
    expect(b.store.readMemory("reviewer")).toBe("- 2026-11-20 prefers small PRs\n");
    expect(b.store.getSkill("tests")).toMatchObject({ name: "Tests", description: "Runs them", body: "Run npm test." });
    expect(b.arrived).toContain("agent:Reviewer:Laptop");
    expect(b.lib.view().agents.reviewer).toMatchObject({ on: true, syncing: true, from: "Laptop", waiting: [], engine: null });
    expect(b.lib.view().skills.tests).toMatchObject({ on: false, syncing: true, via: ["Reviewer"] });
    // In step, the two say nothing more.
    const files = (m: Machine, other: Machine) => fs.readdirSync(path.join(linkDir(m, other), "library", m.id)).map((name) => fs.readFileSync(path.join(linkDir(m, other), "library", m.id, name), "utf8"));
    const before = [files(a, b), files(b, a)];
    await settle(a, b);
    expect([files(a, b), files(b, a)]).toEqual(before);
    // A skill that doesn't sync and isn't carried stays put.
    a.store.writeSkill({ id: "private", name: "Private", description: "", body: "Mine." });
    await settle(a, b);
    expect(b.store.getSkill("private")).toBeNull();
  });

  it("waits for a workspace that isn't on the other machine, and takes it once it is", async () => {
    const a = machine(A, "Laptop");
    const b = machine(B, "Desktop");
    const site = workspace(a, "Site");
    agent(a, { name: "Writer", places: [site] });
    turnOn(a, "agent", "writer");
    await settle(a, b);
    expect(b.store.getAgent("writer")?.places).toEqual([]);
    expect(b.lib.view().agents.writer.waiting).toEqual([{ key: "name:site:", label: "Site", folderId: "", }]);
    // Still waiting, it isn't taken for a removal: the laptop keeps it.
    expect(a.store.getAgent("writer")?.places).toEqual([site]);
    const there = workspace(b, "Site", path.join(b.home, "work", "Site"));
    await settle(a, b);
    expect(b.store.getAgent("writer")?.places).toEqual([there]);
    expect(b.lib.view().agents.writer.waiting).toEqual([]);
  });

  it("uses this machine's CLI when the agent's isn't installed, and keeps asking for its own", async () => {
    const a = machine(A, "Laptop");
    const b = machine(B, "Desktop");
    a.engines.push({ id: "grok", label: "Grok Build", bin: "grok", available: true });
    const site = workspace(a, "Site");
    workspace(b, "Site");
    agent(a, { name: "Builder", engine: "grok", places: [site] });
    turnOn(a, "agent", "builder");
    await settle(a, b);
    expect(b.store.getAgent("builder")?.engine).toBe("claude");
    expect(b.lib.view().agents.builder.engine).toEqual({ wanted: "Grok Build", using: "Claude Code" });
    // An edit on the desktop doesn't change the laptop's CLI.
    b.store.writeAgent({ ...(b.store.getAgent("builder") as Agent), goodAt: "builds" });
    await settle(a, b);
    expect(a.store.getAgent("builder")).toMatchObject({ engine: "grok", goodAt: "builds" });
    // Installed later: used.
    b.engines.push({ id: "grok", label: "Grok Build", bin: "grok", available: true });
    await settle(a, b);
    expect(b.store.getAgent("builder")?.engine).toBe("grok");
    expect(b.lib.view().agents.builder.engine).toBeNull();
  });

  it("joins memories written on both machines while apart", async () => {
    const a = machine(A, "Laptop");
    const b = machine(B, "Desktop");
    agent(a, { name: "Helper" });
    a.store.writeMemory("helper", "- one\n");
    turnOn(a, "agent", "helper");
    await settle(a, b);
    a.store.writeMemory("helper", "- one\n- laptop learned this\n");
    b.store.writeMemory("helper", "- one\n- desktop learned that\n");
    await pass(a, b);
    await pass(b, a);
    await settle(a, b);
    const memory = a.store.readMemory("helper");
    expect(memory).toBe(b.store.readMemory("helper"));
    expect(memory).toContain("- laptop learned this");
    expect(memory).toContain("- desktop learned that");
    expect(a.conflicts.list()).toEqual([]);
    expect(b.conflicts.list()).toEqual([]);
  });

  it("keeps the later brief when both changed the same lines, and the other one to put back", async () => {
    const a = machine(A, "Laptop");
    const b = machine(B, "Desktop");
    agent(a, { name: "Helper", brief: "Be careful.\nRun the tests." });
    turnOn(a, "agent", "helper");
    await settle(a, b);
    // The laptop's change first, then the desktop's: the desktop's is later.
    a.store.writeAgent({ ...(a.store.getAgent("helper") as Agent), brief: "Be very careful.\nRun the tests." });
    await pass(a, b);
    b.store.writeAgent({ ...(b.store.getAgent("helper") as Agent), brief: "Be quick.\nRun the tests." });
    await pass(b, a);
    await settle(a, b);
    expect(a.store.getAgent("helper")?.brief).toBe("Be quick.\nRun the tests.");
    expect(b.store.getAgent("helper")?.brief).toBe("Be quick.\nRun the tests.");
    const waiting = a.conflicts.list();
    expect(waiting).toHaveLength(1);
    expect(waiting[0]).toMatchObject({ kind: "agent", section: "brief", itemId: "helper", path: "Helper" });
    expect(a.conflicts.savedText(waiting[0].id)).toBe("Be very careful.\nRun the tests.");
    expect(b.conflicts.list()).toEqual([]);
    // Put back: it goes to the desktop as the laptop's change.
    a.lib.restore(waiting[0], a.conflicts.savedText(waiting[0].id));
    a.conflicts.resolve(waiting[0].id, "mine");
    await settle(a, b);
    expect(b.store.getAgent("helper")?.brief).toBe("Be very careful.\nRun the tests.");
  });

  it("stops on both when turned off on one, and keeps both copies", async () => {
    const a = machine(A, "Laptop");
    const b = machine(B, "Desktop");
    agent(a, { name: "Helper" });
    turnOn(a, "agent", "helper");
    await settle(a, b);
    b.lib.setOn("agent", "helper", false);
    await settle(a, b);
    expect(a.lib.view().agents.helper).toMatchObject({ on: false, syncing: false });
    a.store.writeAgent({ ...(a.store.getAgent("helper") as Agent), brief: "Only here now." });
    await settle(a, b);
    expect(b.store.getAgent("helper")?.brief).toBe("Review the change.");
  });

  it("deletes on the other machine once Undo is over, unless it changed there meanwhile", async () => {
    const a = machine(A, "Laptop");
    const b = machine(B, "Desktop");
    agent(a, { name: "Gone" });
    agent(a, { name: "Kept" });
    turnOn(a, "agent", "gone");
    turnOn(a, "agent", "kept");
    await settle(a, b);
    fs.rmSync(path.join(a.store.configRoot, "agents", "gone"), { recursive: true });
    fs.rmSync(path.join(a.store.configRoot, "agents", "kept"), { recursive: true });
    await settle(a, b);
    // Still inside Undo: nothing told.
    expect(b.store.getAgent("gone")).not.toBeNull();
    clock += DELETE_GRACE_MS;
    // The desktop changed one of them before it heard.
    b.store.writeMemory("kept", "- changed on the desktop\n");
    await pass(b, a);
    await pass(a, b);
    await settle(a, b);
    expect(b.store.getAgent("gone")).toBeNull();
    expect(b.store.getAgent("kept")).not.toBeNull();
    expect(a.store.listAgents().map((item) => item.name)).toContain("Kept");
    expect(a.store.readMemory(a.store.listAgents().find((item) => item.name === "Kept")?.id ?? "")).toBe("- changed on the desktop\n");
  });

  it.skipIf(process.getuid?.() === 0)("never tells a delete, or an emptied memory, for an agent that is there but can't be read", async () => {
    const a = machine(A, "Laptop");
    const b = machine(B, "Desktop");
    agent(a, { name: "Locked" });
    agent(a, { name: "Fine" });
    a.store.writeMemory("locked", "- keep me\n");
    turnOn(a, "agent", "locked");
    turnOn(a, "agent", "fine");
    await settle(a, b);
    const agents = path.join(a.store.configRoot, "agents");
    // The whole agents folder, past the time a delete waits for its Undo.
    fs.chmodSync(agents, 0o000);
    try {
      await settle(a, b);
      clock += DELETE_GRACE_MS;
      await settle(a, b);
    } finally {
      fs.chmodSync(agents, 0o700);
    }
    expect(b.store.getAgent("locked")).not.toBeNull();
    expect(b.store.getAgent("fine")).not.toBeNull();
    // Only the memory file: what it says isn't sent as nothing.
    const memory = path.join(agents, "locked", "memory.md");
    fs.chmodSync(memory, 0o000);
    try {
      a.store.writeAgent({ ...a.store.getAgent("locked")!, brief: "Changed while the memory was locked." });
      await settle(a, b);
    } finally {
      fs.chmodSync(memory, 0o600);
    }
    expect(b.store.readMemory("locked")).toBe("- keep me\n");
    // Readable again, it syncs as before, the change made meanwhile too.
    await settle(a, b);
    expect(b.store.getAgent("locked")?.brief).toBe("Changed while the memory was locked.");
    expect(a.store.getAgent("locked")).not.toBeNull();
  });

  it("joins a same-named agent with the same brief instead of making a second one", async () => {
    const a = machine(A, "Laptop");
    const b = machine(B, "Desktop");
    agent(a, { name: "Helper" });
    a.store.writeMemory("helper", "- from the laptop\n");
    agent(b, { name: "Helper", id: "helper" });
    b.store.writeMemory("helper", "- from the desktop\n");
    agent(b, { name: "Other", id: "other", brief: "Something else." });
    turnOn(a, "agent", "helper");
    await settle(a, b);
    expect(b.store.listAgents().map((item) => item.id).sort()).toEqual(["helper", "other"]);
    const memory = b.store.readMemory("helper");
    expect(memory).toContain("- from the laptop");
    expect(memory).toContain("- from the desktop");
    expect(a.store.readMemory("helper")).toBe(memory);
  });

  it("refuses a file that isn't one, and takes only what it can check", () => {
    const dir = temp();
    const file = path.join(dir, "vf-ag-0123456789ab.json");
    const write = (value: unknown) => fs.writeFileSync(file, JSON.stringify(value));
    write({ v: 1, kind: "skill", syncId: "vf-ag-0123456789ab", sections: { state: { value: "on", v: { AAAAAAA: 1 }, at: "", by: "AAAAAAA" } } });
    expect(readRecord(file)).toBeNull();
    write({
      v: 1,
      kind: "agent",
      syncId: "vf-ag-0123456789ab",
      sections: {
        state: { value: "on", v: { AAAAAAA: 1 }, at: "", by: "AAAAAAA" },
        places: { value: [{ hint: "/etc" }, { hint: "Projects/site" }], v: { AAAAAAA: 1 }, at: "", by: "AAAAAAA" },
        engine: { value: { id: "../../bin/sh", bin: "/bin/sh" }, v: { AAAAAAA: 1 }, at: "", by: "AAAAAAA" },
        memory: { value: "x".repeat(300 * 1024), v: { AAAAAAA: 1 }, at: "", by: "AAAAAAA" },
        tier: { value: "godlike", v: { lowercase: 1 }, at: "", by: "AAAAAAA" },
      },
    });
    const record = readRecord(file);
    expect(record?.sections.places?.value).toEqual([{ key: "home:Projects/site", workspace: "", folderId: "", sub: "", hint: "Projects/site" }]);
    expect(record?.sections.engine).toBeUndefined();
    expect(record?.sections.memory).toBeUndefined();
    expect(record?.sections.tier).toBeUndefined();
  });
});
