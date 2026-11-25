import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EngineDevice, EngineFolder } from "../../src/core/sync/types.js";

// Sync in the main process (electron/sync.ts) driven by Settings alone, with a stand-in for the
// private Syncthing: what a change in Settings → Sync reaches while sync is already running.

const A = "TIKSU4F-FTL4JMP-6WX2WN7-HAXB57C-6IVGIQ7-U7ZUQKP-KCA2BBD-D7RSEAV";
const B = "MTOM47S-JJWJ5ZV-ILPEULO-TWZVT4L-NH4YGIY-4FU5CNV-NOGQ3O6-VEV56AH";

const started = vi.hoisted(() => [] as Array<{ name: string }>);

vi.mock("../../electron/sync-engine.js", () => {
  class FakeEngine {
    readonly id = A;
    name = "";
    devicesNow: EngineDevice[] = [{ id: A, name: "", addresses: ["dynamic"] }];
    foldersNow: EngineFolder[] = [];
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
      return [];
    }
    async dismissPendingDevice() {}
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
      return {};
    }
    async folderStatus() {
      return null;
    }
    async scan() {}
    async revert() {}
    async listenError() {
      return null;
    }
    async stop() {}
  }
  return {
    Syncthing: {
      start: async () => {
        const engine = new FakeEngine();
        started.push(engine);
        return engine;
      },
    },
  };
});

const { Sync } = await import("../../electron/sync.js");

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  vi.unstubAllEnvs();
  started.length = 0;
});

function running(settings: { sync: { enabled: boolean; name: string } }) {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vibeforge-sync-settings-"));
  made.push(dataRoot);
  // Already paired with one machine, so this one writes it a note.
  fs.mkdirSync(path.join(dataRoot, "sync"), { recursive: true });
  fs.writeFileSync(path.join(dataRoot, "sync", "state.json"), JSON.stringify({ machines: [{ id: B, name: "Lap", addresses: [] }], shares: [], stopped: {}, ignored: [] }));
  // Any file will do for the binary: the stand-in starts instead.
  vi.stubEnv("VIBEFORGE_SYNCTHING", process.execPath);
  const service = {
    getSettings: () => ({ ...settings, notify: false, defaultEngine: "claude" }),
    emit: vi.fn(),
    listWorkspaces: () => ({ workspaces: [] }),
    listLive: () => [],
    listAgents: () => [],
    listSkills: () => [],
    listEngines: () => [],
  };
  const ctx = { service, roots: { dataRoot }, appRoot: dataRoot, log: { info: vi.fn(), warn: vi.fn() }, words: { coreText: (text: string) => text } } as never;
  const note = () => JSON.parse(fs.readFileSync(path.join(dataRoot, "sync", "link", B.slice(0, 7), `${A}.json`), "utf8")) as { name: string };
  return { sync: new Sync(ctx, vi.fn()), note };
}

describe("sync settings while sync runs", () => {
  it("tells Syncthing and the paired machine when this machine is renamed", async () => {
    const settings = { sync: { enabled: true, name: "Desk" } };
    const { sync, note } = running(settings);
    await sync.apply();
    expect(started).toHaveLength(1);
    expect(started[0].name).toBe("Desk");
    expect(note().name).toBe("Desk");

    // Renamed in Settings → Sync: saving settings applies them again, with Syncthing still running.
    settings.sync.name = "Office";
    await sync.apply();
    await vi.waitFor(() => expect(note().name).toBe("Office"));
    expect(started[0].name).toBe("Office");
    expect(started).toHaveLength(1);
    await sync.stop();
  });
});
