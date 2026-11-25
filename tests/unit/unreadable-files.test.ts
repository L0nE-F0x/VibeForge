import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { watchConfig } from "../../electron/config-watch.js";
import { seedEngines } from "../../src/core/engines.js";
import { Store } from "../../src/core/store.js";
import { EMPTY_FILE, JsonFiles, NOT_A_LIST } from "../../src/core/store/json-files.js";
import type { Settings, Topic } from "../../src/core/types.js";
import { matchCoreText } from "../../src/ui/core-text.js";

// A settings file that fails to read (a CLI or an editor writing it in place, a hand edit half
// done, a file cut short) never turns into defaults: the last good copy is served, nothing is
// saved over it, and it is only moved aside when the person chooses.

const stores: Store[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "vf-unreadable-"));
}

function open(configRoot = tempDir(), dataRoot = tempDir()): Store {
  const store = new Store(configRoot, dataRoot);
  stores.push(store);
  return store;
}

/** Sync and the phone page on, as someone who uses both has them. */
function networked(store: Store): Settings {
  const settings = store.readSettings();
  const next: Settings = { ...settings, defaultEngine: "codex", sync: { enabled: true, name: "desk" }, companion: { ...settings.companion, enabled: true, token: "vf_code" } };
  store.writeSettings(next);
  return store.readSettings();
}

/** What a write in place leaves for a moment: the file cut short. Also a fresh stamp, so no cache can answer. */
function cutShort(file: string, keep = 0.5): string {
  const text = fs.readFileSync(file, "utf8");
  const short = text.slice(0, Math.floor(text.length * keep));
  fs.writeFileSync(file, short);
  return short;
}

describe("a settings file that can't be read", () => {
  it("keeps serving the last good settings, so Sync and the phone page stay on, and says which file and why", () => {
    const store = open();
    const changes: number[] = [];
    store.onUnreadableChange(() => changes.push(store.unreadableFiles().length));
    const before = networked(store);
    const file = path.join(store.configRoot, "settings.json");

    const whole = fs.readFileSync(file, "utf8");
    for (const keep of [0, 0.5]) {
      fs.writeFileSync(file, whole);
      const short = cutShort(file, keep);
      const read = store.readSettings();
      expect(read).toEqual(before);
      expect(read.sync.enabled).toBe(true);
      expect(read.companion.enabled).toBe(true);
      const [problem] = store.unreadableFiles();
      expect(problem).toMatchObject({ file, name: "settings.json", saved: true });
      expect(problem.error).toEqual(keep === 0 ? EMPTY_FILE : expect.stringMatching(/JSON/));
      // Nothing is written over it, and nothing is moved aside, until the person says so.
      expect(fs.readFileSync(file, "utf8")).toBe(short);
      expect(fs.existsSync(`${file}.broken`)).toBe(false);
    }
    expect(changes[0]).toBe(1);

    // Fixed (the CLI finished writing): read as usual, and no longer listed.
    fs.writeFileSync(file, JSON.stringify({ defaultEngine: "claude", sync: { enabled: true } }));
    expect(store.readSettings()).toMatchObject({ defaultEngine: "claude", sync: { enabled: true } });
    expect(store.unreadableFiles()).toEqual([]);
    expect(changes.at(-1)).toBe(0);
  });

  it("refuses a save over it with a sentence the window translates, and leaves the file as it is", () => {
    const store = open();
    networked(store);
    const file = path.join(store.configRoot, "settings.json");
    const short = cutShort(file);
    let message = "";
    try {
      store.writeSettings({ ...store.readSettings(), notify: false });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/^settings\.json can't be read \(.+\), so nothing was saved over it\.$/);
    expect(matchCoreText(message)?.key).toBe("core.unreadableNotSaved");
    expect(matchCoreText(EMPTY_FILE)?.key).toBe("core.fileEmpty");
    expect(matchCoreText(NOT_A_LIST)?.key).toBe("core.fileNotList");
    expect(fs.readFileSync(file, "utf8")).toBe(short);
    expect(fs.readdirSync(store.configRoot).filter((name) => name.includes(".broken"))).toEqual([]);
  });

  it("starts from the copy saved last session, and Use the saved copy puts it back with the broken one set aside", () => {
    const configRoot = tempDir();
    const dataRoot = tempDir();
    const first = open(configRoot, dataRoot);
    const before = networked(first);
    first.close();
    stores.splice(stores.indexOf(first), 1);
    const file = path.join(configRoot, "settings.json");
    expect(JSON.parse(fs.readFileSync(`${file}.saved`, "utf8"))).toMatchObject({ sync: { enabled: true } });
    expect(fs.statSync(`${file}.saved`).mode & 0o777).toBe(0o600);
    // A power cut, say: the file comes back empty.
    fs.writeFileSync(file, "");

    const store = open(configRoot, dataRoot);
    expect(store.readSettings()).toEqual(before);
    expect(store.unreadableFiles()).toEqual([{ file, name: "settings.json", error: EMPTY_FILE, saved: true }]);
    // Only a file listed as unreadable can be put back.
    expect(store.restoreSavedCopy(path.join(configRoot, "engines.json"))).toBe(false);
    expect(store.restoreSavedCopy(file)).toBe(true);
    expect(fs.readFileSync(`${file}.broken`, "utf8")).toBe("");
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toMatchObject({ sync: { enabled: true }, companion: { enabled: true } });
    expect(store.unreadableFiles()).toEqual([]);
    expect(store.readSettings()).toEqual(before);
  });

  it("with no earlier copy reads defaults, and Move it aside lets a new file start", () => {
    const fresh = open();
    const file = path.join(fresh.configRoot, "settings.json");
    const halfEdited = '{ "defaultEngine": "codex", "theme": "builtin",\n';
    fs.writeFileSync(file, halfEdited);
    expect(fresh.readSettings()).toMatchObject({ defaultEngine: "claude", theme: "omarchy", sync: { enabled: false } });
    expect(fresh.unreadableFiles()).toMatchObject([{ name: "settings.json", saved: false }]);
    expect(fs.readFileSync(file, "utf8")).toBe(halfEdited);
    expect(fresh.restoreSavedCopy(file)).toBe(true);
    expect(fs.readFileSync(`${file}.broken`, "utf8")).toBe(halfEdited);
    expect(fresh.readSettings().defaultEngine).toBe("claude");
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toMatchObject({ version: 1, defaultEngine: "claude" });
    expect(fresh.unreadableFiles()).toEqual([]);
  });

  it("doesn't write defaults over a settings.json that went missing for a moment (an editor saving by rename)", () => {
    const store = open();
    const before = networked(store);
    const file = path.join(store.configRoot, "settings.json");
    fs.renameSync(file, `${file}~`);
    expect(store.readSettings()).toEqual(before);
    expect(fs.existsSync(file)).toBe(false);
    fs.renameSync(`${file}~`, file);
    expect(store.readSettings()).toEqual(before);
  });

  it("lists a file that parses but holds no settings, and one that can't be opened", () => {
    const store = open();
    networked(store);
    const file = path.join(store.configRoot, "settings.json");
    fs.writeFileSync(file, "null\n");
    expect(store.readSettings().sync.enabled).toBe(true);
    expect(store.unreadableFiles()[0]?.error).toBe(NOT_A_LIST);
    fs.rmSync(file);
    fs.mkdirSync(file);
    expect(store.readSettings().sync.enabled).toBe(true);
    expect(store.unreadableFiles()[0]?.error).toMatch(/EISDIR/);
  });
});

describe("the other files kept the same way", () => {
  it("keeps the workspaces, CLIs and chats from the last good read, and saves over none of them", () => {
    const store = open();
    const folder = tempDir();
    store.writeWorkspaces({ workspaces: [{ id: "w1", name: "Mine", path: folder, dockUrl: "" }], lastWorkspaceId: "w1" });
    const custom = { ...seedEngines()[0], id: "mycli", label: "My CLI", bin: "mycli" };
    store.writeEngineRows([...store.readEngineRows(), custom]);
    store.writeChat({ id: "c1", title: "Hello", agentId: null, engine: "claude", cwd: folder, runIds: [], createdAt: "2026-11-25T00:00:00Z", updatedAt: "2026-11-25T00:00:00Z" });

    const workspaces = path.join(store.configRoot, "workspaces.json");
    const engines = path.join(store.configRoot, "engines.json");
    const chats = path.join(store.dataRoot, "chats.json");
    for (const file of [workspaces, engines, chats]) cutShort(file);

    expect(store.readWorkspaces().workspaces.map((item) => item.id)).toEqual(["w1"]);
    expect(store.readEngineRows().map((row) => row.id)).toContain("mycli");
    expect(store.listChats().map((chat) => chat.id)).toEqual(["c1"]);
    expect(store.unreadableFiles().map((item) => item.name).sort()).toEqual(["chats.json", "engines.json", "workspaces.json"]);

    const short = Object.fromEntries([workspaces, engines, chats].map((file) => [file, fs.readFileSync(file, "utf8")]));
    expect(() => store.writeWorkspaces({ workspaces: [], lastWorkspaceId: null })).toThrow(/^workspaces\.json can't be read/);
    expect(() => store.writeEngineRows(seedEngines())).toThrow(/^engines\.json can't be read/);
    expect(() => store.writeChat({ id: "c2", title: "Two", agentId: null, engine: "claude", cwd: folder, runIds: [], createdAt: "", updatedAt: "" })).toThrow(/^chats\.json can't be read/);
    expect(() => store.deleteChat("c1")).toThrow(/^chats\.json can't be read/);
    for (const file of [workspaces, engines, chats]) expect(fs.readFileSync(file, "utf8")).toBe(short[file]);

    expect(store.restoreSavedCopy(chats)).toBe(true);
    expect(store.listChats().map((chat) => chat.id)).toEqual(["c1"]);
    expect(store.unreadableFiles().map((item) => item.name).sort()).toEqual(["engines.json", "workspaces.json"]);
  });

  it("doesn't put a saved copy back over a file that reads again by the time the person chooses", () => {
    const files = new JsonFiles();
    const dir = tempDir();
    const file = path.join(dir, "settings.json");
    files.write(file, { a: 1 });
    fs.writeFileSync(file, "{");
    expect(files.read(file).state).toBe("unreadable");
    fs.writeFileSync(file, '{ "a": 2 }');
    expect(files.restoreSaved(file)).toBe(false);
    expect(fs.readFileSync(file, "utf8")).toBe('{ "a": 2 }');
    expect(fs.existsSync(`${file}.broken`)).toBe(false);
  });
});

describe("a file cut short while the config folder is watched", () => {
  let stop: () => void = () => {};
  afterEach(() => stop());

  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const until = async (check: () => boolean, ms = 10_000) => {
    for (const end = Date.now() + ms; !check() && Date.now() < end; ) await sleep(20);
  };

  it("never turns Sync or the phone page off, and lists the file until it reads again", async () => {
    const store = open();
    networked(store);
    const file = path.join(store.configRoot, "settings.json");
    const whole = fs.readFileSync(file, "utf8");
    // What main.ts does on a settings change: read them, and start or stop what they switch.
    const seen: Array<{ sync: boolean; phone: boolean; unreadable: string[] }> = [];
    stop = watchConfig(store.configRoot, (topics: Topic[]) => {
      if (!topics.includes("settings")) return;
      const settings = store.readSettings();
      seen.push({ sync: settings.sync.enabled, phone: settings.companion.enabled, unreadable: store.unreadableFiles().map((item) => item.name) });
    });
    await sleep(100);

    // A CLI writing it in place, slowly: cut short, then whole again.
    for (let tries = 0; tries < 10 && !seen.length; tries += 1) {
      fs.writeFileSync(file, whole.slice(0, 40));
      await until(() => seen.length > 0, 1000);
    }
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.at(-1)?.unreadable).toEqual(["settings.json"]);
    const during = seen.length;
    fs.writeFileSync(file, whole);
    await until(() => seen.length > during);
    expect(seen.at(-1)?.unreadable).toEqual([]);
    expect(seen.every((state) => state.sync && state.phone)).toBe(true);
  });
});
