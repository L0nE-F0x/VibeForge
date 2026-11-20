import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { lockDown } from "../src/core/sync/protocol.js";
import type { EngineDevice, EngineEvent, EngineFolder, EngineFolderStatus, SyncEngine } from "../src/core/sync/types.js";

// VibeForge's private Syncthing: the binary a copy of VibeForge carries (vendor/syncthing), with
// its own home under VibeForge's data folder, started with VibeForge and stopped with it. Its
// settings are locked down before every start (src/core/sync/protocol.ts): it talks to paired
// machines directly and to nothing else. Its web interface answers on loopback only, on a port
// and with a key made fresh each start, and only this file uses it.

export interface SyncthingOptions {
  binary: string;
  /** Its keys, settings and index. */
  home: string;
  /** `tcp://:22737`: where paired machines connect. */
  listen: string;
  /** Announce on the local network. */
  discovery: boolean;
  discoveryPort?: number;
  log: (line: string) => void;
  onEvent: (event: EngineEvent) => void;
  /** It went away without being asked to. */
  onExit: (why: string) => void;
}

const EVENTS = ["DeviceConnected", "DeviceDisconnected", "PendingDevicesChanged", "StateChanged", "ItemFinished", "FolderSummary", "ConfigSaved"];
const START_MS = 30_000;
const STOP_MS = 5000;

function run(file: string, args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number; text: string }> {
  return new Promise((resolve) => {
    execFile(file, args, { env, encoding: "utf8", timeout: 60_000 }, (error, stdout, stderr) => {
      const code = (error as { code?: unknown } | null)?.code;
      resolve({ code: error ? (typeof code === "number" ? code : 1) : 0, text: `${stdout ?? ""}${stderr ?? ""}` });
    });
  });
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      probe.close(() => (address && typeof address === "object" ? resolve(address.port) : reject(new Error("No free port for Syncthing's interface."))));
    });
  });
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Stops a Syncthing left running by a VibeForge that crashed: it holds the home and the port. */
async function stopLeftover(home: string, log: (line: string) => void): Promise<void> {
  const file = path.join(home, "vibeforge.pid");
  let pid = 0;
  try {
    pid = Number(fs.readFileSync(file, "utf8").trim());
  } catch {
    return;
  }
  fs.rmSync(file, { force: true });
  if (!Number.isInteger(pid) || pid <= 1 || !alive(pid)) return;
  let command = "";
  try {
    command = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8");
  } catch {
    return;
  }
  // Only ever its own: the same home on its command line.
  if (!command.includes("syncthing") || !command.includes(home)) return;
  log("Sync: stopping a Syncthing left over from the last run");
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      return;
    }
  }
  for (let waited = 0; waited < STOP_MS && alive(pid); waited += 100) await sleep(100);
  if (alive(pid)) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      /* gone */
    }
  }
}

export class Syncthing implements SyncEngine {
  readonly id: string;
  private stopping = false;
  private readonly abort = new AbortController();

  private constructor(
    private readonly child: ChildProcess,
    private readonly base: string,
    private readonly key: string,
    id: string,
    private readonly options: SyncthingOptions,
  ) {
    this.id = id;
  }

  /** Starts it and waits until it answers. Throws with a sentence a person can read when it can't. */
  static async start(options: SyncthingOptions): Promise<Syncthing> {
    if (!fs.existsSync(options.binary)) throw new Error("This copy of VibeForge has no sync engine yet.");
    fs.mkdirSync(options.home, { recursive: true, mode: 0o700 });
    await stopLeftover(options.home, options.log);
    const env: NodeJS.ProcessEnv = { ...process.env, STNOUPGRADE: "1", STNOBROWSER: "1" };
    const config = path.join(options.home, "config.xml");
    if (!fs.existsSync(config)) {
      const made = await run(options.binary, ["generate", `--home=${options.home}`, "--no-port-probing"], env);
      if (made.code !== 0 || !fs.existsSync(config)) throw new Error(`Syncthing could not make its settings: ${made.text.trim().split("\n").pop() ?? ""}`);
    }
    // Before every start, so nothing in the file can make it reach outside.
    fs.writeFileSync(config, lockDown(fs.readFileSync(config, "utf8"), { listen: options.listen, discovery: options.discovery, discoveryPort: options.discoveryPort }), { mode: 0o600 });

    const port = await freePort();
    const key = randomBytes(24).toString("hex");
    const child = spawn(options.binary, ["serve", `--home=${options.home}`, "--no-browser", "--no-upgrade", "--no-restart", "--no-port-probing", `--gui-address=http://127.0.0.1:${port}`], {
      // The key goes in the environment, not on the command line, where `ps` would show it.
      env: { ...env, STGUIAPIKEY: key },
      stdio: ["ignore", "pipe", "pipe"],
      // Its own process group, so the pair it runs as (a monitor and the worker) can be ended together.
      detached: true,
    });
    let tail = "";
    const read = (chunk: Buffer) => {
      for (const line of chunk.toString("utf8").split("\n")) {
        if (!line.trim()) continue;
        tail = line;
        if (/ (WRN|ERR) /.test(line)) options.log(`Syncthing: ${line.replace(/^\S+ \S+ /, "").slice(0, 300)}`);
      }
    };
    child.stdout?.on("data", read);
    child.stderr?.on("data", read);
    let exited: string | null = null;
    child.once("error", (error) => (exited = error.message));
    child.once("exit", (code, signal) => (exited = `Syncthing stopped (${signal ?? `code ${code}`}): ${tail.replace(/^\S+ \S+ /, "").slice(0, 200)}`));
    if (child.pid) fs.writeFileSync(path.join(options.home, "vibeforge.pid"), `${child.pid}\n`);

    const base = `http://127.0.0.1:${port}`;
    const started = Date.now();
    let id = "";
    while (!id) {
      if (exited) throw new Error(exited);
      if (Date.now() - started > START_MS) {
        // Kill the detached process group so the child worker doesn't outlive the monitor.
        if (child.pid) {
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch {
            child.kill("SIGKILL");
          }
        } else {
          child.kill("SIGKILL");
        }
        throw new Error("Syncthing did not start in time.");
      }
      try {
        const response = await fetch(`${base}/rest/system/status`, { headers: { "X-API-Key": key }, signal: AbortSignal.timeout(2000) });
        if (response.ok) id = String(((await response.json()) as { myID?: string }).myID ?? "");
      } catch {
        /* not up yet */
      }
      if (!id) await sleep(150);
    }
    const engine = new Syncthing(child, base, key, id, options);
    child.once("exit", (code, signal) => {
      fs.rmSync(path.join(options.home, "vibeforge.pid"), { force: true });
      if (!engine.stopping) options.onExit(`Syncthing stopped (${signal ?? `code ${code}`}).`);
    });
    void engine.listen();
    return engine;
  }

  /** Ends it: asked first, then told, then killed. */
  async stop(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    this.abort.abort();
    const gone = new Promise<void>((resolve) => (this.child.exitCode !== null || this.child.signalCode ? resolve() : this.child.once("exit", () => resolve())));
    const within = (ms: number) => Promise.race([gone.then(() => true), sleep(ms).then(() => false)]);
    await this.call("POST", "/rest/system/shutdown").catch(() => undefined);
    if (await within(STOP_MS)) return;
    this.signal("SIGTERM");
    if (await within(STOP_MS)) return;
    this.signal("SIGKILL");
    await within(1000);
  }

  private signal(name: NodeJS.Signals): void {
    const pid = this.child.pid;
    if (!pid) return;
    try {
      process.kill(-pid, name);
    } catch {
      this.child.kill(name);
    }
  }

  // ------------------------------------------------------------------ REST

  private async call<T = unknown>(method: string, route: string, body?: unknown, timeoutMs = 15_000): Promise<T> {
    const response = await fetch(`${this.base}${route}`, {
      method,
      headers: { "X-API-Key": this.key, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`Syncthing answered ${response.status} to ${method} ${route.split("?")[0]}: ${text.trim().slice(0, 200)}`);
    return (text.trim() ? JSON.parse(text) : null) as T;
  }

  /** Long-polls for events until stopped. */
  private async listen(): Promise<void> {
    let since = 0;
    while (!this.stopping) {
      try {
        const response = await fetch(`${this.base}/rest/events?since=${since}&timeout=30&events=${EVENTS.join(",")}`, { headers: { "X-API-Key": this.key }, signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(45_000)]) });
        if (!response.ok) throw new Error(String(response.status));
        const events = ((await response.json()) ?? []) as Array<{ id: number; type: string; data: Record<string, unknown> | null }>;
        for (const event of events) {
          since = Math.max(since, event.id);
          const mapped = mapEvent(event.type, event.data ?? {});
          if (mapped) {
            try {
              this.options.onEvent(mapped);
            } catch (error) {
              this.options.log(`Sync: an event could not be handled: ${error instanceof Error ? error.message : String(error)}`);
            }
          }
        }
      } catch {
        if (this.stopping) return;
        await sleep(1000);
      }
    }
  }

  // ------------------------------------------------------------------ SyncEngine

  async setName(name: string): Promise<void> {
    const me = await this.call<{ name?: string }>("GET", `/rest/config/devices/${this.id}`);
    if (me.name !== name) await this.call("PATCH", `/rest/config/devices/${this.id}`, { name });
  }

  async devices(): Promise<EngineDevice[]> {
    const rows = await this.call<Array<{ deviceID: string; name: string; addresses: string[] }>>("GET", "/rest/config/devices");
    return rows.map((row) => ({ id: row.deviceID, name: row.name ?? "", addresses: row.addresses ?? [] }));
  }

  async putDevice(device: EngineDevice): Promise<void> {
    const known = (await this.devices()).some((row) => row.id === device.id);
    if (known) await this.call("PATCH", `/rest/config/devices/${device.id}`, { name: device.name, addresses: device.addresses });
    // Never an introducer, never auto-accepting: this machine only syncs what a person here said yes to.
    else await this.call("POST", "/rest/config/devices", { deviceID: device.id, name: device.name, addresses: device.addresses, introducer: false, autoAcceptFolders: false });
  }

  async removeDevice(id: string): Promise<void> {
    await this.call("DELETE", `/rest/config/devices/${id}`);
  }

  async pendingDevices(): Promise<Array<{ id: string; name: string; address: string }>> {
    const rows = await this.call<Record<string, { name?: string; address?: string }>>("GET", "/rest/cluster/pending/devices");
    return Object.entries(rows ?? {}).map(([id, row]) => ({ id, name: row.name ?? "", address: row.address ?? "" }));
  }

  async dismissPendingDevice(id: string): Promise<void> {
    await this.call("DELETE", `/rest/cluster/pending/devices?device=${encodeURIComponent(id)}`);
  }

  async folders(): Promise<EngineFolder[]> {
    const rows = await this.call<Array<{ id: string; label: string; path: string; type: EngineFolder["type"]; fsWatcherDelayS: number; devices: Array<{ deviceID: string }> }>>("GET", "/rest/config/folders");
    return rows.map((row) => ({
      id: row.id,
      label: row.label ?? "",
      path: row.path,
      type: row.type,
      watchDelay: row.fsWatcherDelayS,
      devices: (row.devices ?? []).map((device) => device.deviceID).filter((id) => id !== this.id),
    }));
  }

  async putFolder(folder: EngineFolder): Promise<void> {
    const body = {
      label: folder.label,
      path: folder.path,
      type: folder.type,
      fsWatcherEnabled: true,
      fsWatcherDelayS: folder.watchDelay,
      devices: [this.id, ...folder.devices].map((deviceID) => ({ deviceID })),
    };
    const known = (await this.folders()).some((row) => row.id === folder.id);
    if (known) await this.call("PATCH", `/rest/config/folders/${folder.id}`, body);
    else await this.call("POST", "/rest/config/folders", { id: folder.id, rescanIntervalS: 3600, ...body });
  }

  async removeFolder(id: string): Promise<void> {
    await this.call("DELETE", `/rest/config/folders/${id}`);
  }

  async connections(): Promise<Record<string, { connected: boolean; address: string; lastSeen: string }>> {
    const [live, stats] = await Promise.all([
      this.call<{ connections: Record<string, { connected: boolean; address: string }> }>("GET", "/rest/system/connections"),
      this.call<Record<string, { lastSeen?: string }>>("GET", "/rest/stats/device"),
    ]);
    const found: Record<string, { connected: boolean; address: string; lastSeen: string }> = {};
    for (const [id, row] of Object.entries(live.connections ?? {})) {
      const seen = stats?.[id]?.lastSeen ?? "";
      // Syncthing says 1970 for a machine it has never seen.
      found[id] = { connected: Boolean(row.connected), address: row.address ?? "", lastSeen: seen && new Date(seen).getTime() > 86_400_000 ? new Date(seen).toISOString() : "" };
    }
    return found;
  }

  async folderStatus(id: string): Promise<EngineFolderStatus | null> {
    try {
      const row = await this.call<{ state: string; needTotalItems: number; errors: number; pullErrors: number; receiveOnlyTotalItems: number }>("GET", `/rest/db/status?folder=${encodeURIComponent(id)}`);
      return { state: row.state ?? "", need: row.needTotalItems ?? 0, errors: (row.errors ?? 0) + (row.pullErrors ?? 0), localChanges: row.receiveOnlyTotalItems ?? 0 };
    } catch {
      return null;
    }
  }

  async scan(folder: string, sub?: string): Promise<void> {
    await this.call("POST", `/rest/db/scan?folder=${encodeURIComponent(folder)}${sub ? `&sub=${encodeURIComponent(sub)}` : ""}`);
  }

  async revert(folder: string): Promise<void> {
    await this.call("POST", `/rest/db/revert?folder=${encodeURIComponent(folder)}`);
  }

  /** Cuts or restores the connection to one machine. For tests: a person has no switch for it. */
  async setPaused(device: string, paused: boolean): Promise<void> {
    await this.call("PATCH", `/rest/config/devices/${device}`, { paused });
  }

  /** Why paired machines can't reach this one, when its port couldn't be opened; null when it listens. */
  async listenError(): Promise<string | null> {
    const status = await this.call<{ connectionServiceStatus?: Record<string, { error: string | null }> }>("GET", "/rest/system/status");
    const errors = Object.values(status.connectionServiceStatus ?? {}).map((row) => row.error).filter((error): error is string => Boolean(error));
    return errors[0] ?? null;
  }
}

function mapEvent(type: string, data: Record<string, unknown>): EngineEvent | null {
  const text = (key: string) => (typeof data[key] === "string" ? (data[key] as string) : "");
  switch (type) {
    case "DeviceConnected":
      return { type: "connected", device: text("id") };
    case "DeviceDisconnected":
      return { type: "disconnected", device: text("id") };
    case "PendingDevicesChanged":
      return { type: "pending-devices" };
    case "StateChanged":
      return { type: "folder-state", folder: text("folder"), state: text("to") };
    case "ItemFinished":
      return { type: "item-finished", folder: text("folder"), item: text("item"), action: text("action"), error: text("error") || null };
    case "FolderSummary":
      return { type: "folder-summary", folder: text("folder") };
    case "ConfigSaved":
      return { type: "config" };
    default:
      return null;
  }
}
