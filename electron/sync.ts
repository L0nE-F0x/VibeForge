import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describeError } from "../src/core/log.js";
import { SyncDesk } from "../src/core/sync/desk.js";
import type { ItemKind, LibraryHost, LibraryView } from "../src/core/sync/library.js";
import type { MergeResult } from "../src/core/sync/git-rescue.js";
import { firewallCommand, machineAddresses, SYNC_PORT, type SyncMode } from "../src/core/sync/protocol.js";
import { EMPTY_SYNC_VIEW, type SyncView } from "../src/core/sync/types.js";
import type { MainContext } from "./main-context.js";
import type { Notify } from "./notify.js";
import { Syncthing } from "./sync-engine.js";

// Workspace sync in the main process: starts VibeForge's private Syncthing when Settings turn sync
// on, stops it when they turn it off or VibeForge quits, and puts the desk (src/core/sync/desk.ts)
// between it and the window. Nothing listens and nothing is sent until sync is on.

/** How long before trying again after Syncthing failed to start or went away. */
const RETRY_MS = 30_000;

export class Sync {
  private desk: SyncDesk | null = null;
  private engine: Syncthing | null = null;
  private error: string | null = null;
  private job: Promise<void> = Promise.resolve();
  private retry: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(
    private readonly ctx: MainContext,
    private readonly notify: Notify,
  ) {}

  /** The Syncthing this copy carries. VIBEFORGE_SYNCTHING names another one, for tests. */
  private binary(): string {
    return process.env.VIBEFORGE_SYNCTHING || path.join(this.ctx.appRoot, "vendor", "syncthing", "syncthing");
  }

  /** Where its Syncthing is and which version it carries, for Settings → This computer. */
  engineInfo(): { path: string; version: string } {
    return { path: this.binary(), version: this.engineVersion() };
  }

  private get listen(): string {
    return process.env.VIBEFORGE_SYNC_LISTEN || `tcp://:${SYNC_PORT}`;
  }

  private get port(): number {
    return Number(/:(\d+)$/.exec(this.listen)?.[1]) || SYNC_PORT;
  }

  private engineVersion(): string {
    try {
      return String((JSON.parse(fs.readFileSync(path.join(this.ctx.appRoot, "scripts", "syncthing.json"), "utf8")) as { version?: string }).version ?? "");
    } catch {
      return "";
    }
  }

  /** What to run so ufw lets the other machine in, read from ufw's own files; null when it is off or already open. */
  private firewall(): string | null {
    try {
      return firewallCommand(fs.readFileSync("/etc/ufw/ufw.conf", "utf8"), fs.readFileSync("/etc/ufw/user.rules", "utf8"), this.port);
    } catch {
      return null;
    }
  }

  /** The saved agents and skills, as the desk syncs the ones a person turned on. */
  private libraryHost(): LibraryHost {
    const { ctx } = this;
    const service = () => {
      if (!ctx.service) throw new Error("VibeForge is still starting.");
      return ctx.service;
    };
    return {
      // Strict reads: an agent or skill that is there but can't be read throws, so it is never taken
      // for one deleted here and deleted on the other machines too.
      agents: () => service().listAgents(),
      getAgent: (id) => service().store.readAgent(id),
      saveAgent: (agent) => service().store.writeAgent(agent),
      readMemory: (id) => service().store.readMemory(id),
      writeMemory: (id, text) => service().store.writeMemory(id, text),
      skills: () => service().listSkills(),
      getSkill: (id) => service().store.readSkill(id),
      saveSkill: (skill) => service().store.writeSkill(skill),
      newId: (kind, name) => service().freeId(kind === "agent" ? "agents" : "skills", name, ""),
      // As a delete here: anything running as the agent stops, and it goes to the trash.
      remove: async (kind, id) => {
        if (kind === "agent") await service().deleteAgent(id);
        else service().deleteSkill(id);
      },
      engines: () => service().listEngines().map((engine) => ({ id: engine.id, label: engine.label, bin: engine.bin, available: engine.available })),
      defaultEngine: () => service().getSettings().defaultEngine,
      arrived: (kind, name, machine) => {
        if (!ctx.service?.getSettings().notify) return;
        const body = kind === "agent" ? `${machine} shared the agent ${name}. It is in Agents now.` : `${machine} shared the skill ${name}. It is in Skills now.`;
        this.notify({ title: "VibeForge", body: ctx.words.coreText(body) });
      },
      changed: (kinds) => ctx.service?.emit(...(kinds.includes("agent") ? (["agents", "routines", "tasks"] as const) : []), ...(kinds.includes("skill") ? (["skills", "agents"] as const) : []), "sync"),
      log: (line) => ctx.log.info(line),
    };
  }

  private makeDesk(): SyncDesk {
    const { ctx } = this;
    this.desk ??= new SyncDesk(ctx.roots.dataRoot, {
      home: os.homedir(),
      machineName: () => ctx.service?.getSettings().sync.name || os.hostname() || "This machine",
      addresses: () => machineAddresses(os.networkInterfaces(), this.port),
      workspaces: () => ctx.service?.listWorkspaces().workspaces ?? [],
      addWorkspace: (folder, name) => void ctx.service?.addWorkspaceQuietly(folder, name),
      live: () => ctx.service?.listLive() ?? [],
      notify: (note) => {
        if (ctx.service?.getSettings().notify) this.notify({ title: note.title, body: ctx.words.coreText(note.body) });
      },
      changed: () => ctx.service?.emit("sync"),
      log: (line) => ctx.log.info(line),
      library: this.libraryHost(),
    });
    return this.desk;
  }

  private enqueue(task: () => Promise<void>): Promise<void> {
    const run = this.job.then(task, task);
    this.job = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** Brings sync in line with Settings: started when on, stopped when off. */
  apply(): Promise<void> {
    return this.enqueue(async () => {
      const service = this.ctx.service;
      if (!service || this.stopped) return;
      const on = service.getSettings().sync.enabled;
      if (this.retry) clearTimeout(this.retry);
      this.retry = null;
      if (!on) {
        await this.halt();
        this.error = null;
        return;
      }
      if (this.engine || !fs.existsSync(this.binary())) return;
      const desk = this.makeDesk();
      try {
        const engine = await Syncthing.start({
          binary: this.binary(),
          home: desk.engineHome,
          listen: this.listen,
          discovery: process.env.VIBEFORGE_SYNC_DISCOVERY !== "0",
          log: (line) => this.ctx.log.info(line),
          onEvent: (event) => desk.onEvent(event),
          onExit: (why) => {
            this.ctx.log.warn(`Sync: ${why}`);
            this.engine = null;
            desk.detach();
            this.error = why;
            this.again();
            this.ctx.service?.emit("sync");
          },
        });
        this.engine = engine;
        this.error = null;
        await desk.attach(engine);
        desk.setLive();
        // It runs, but a port already taken means the other machine can't call in.
        const blocked = await engine.listenError().catch(() => null);
        if (blocked) this.error = `Other machines can't reach this one: ${blocked}`;
        this.ctx.log.info(`Sync: Syncthing ${this.engineVersion()} is running, listening on ${this.listen}${blocked ? ` (${blocked})` : ""}`);
      } catch (error) {
        this.error = describeError(error).split("\n")[0];
        this.ctx.log.warn(`Sync could not start: ${this.error}`);
        await this.halt();
        this.again();
      }
      service.emit("sync");
    });
  }

  private again(): void {
    if (this.retry || this.stopped) return;
    this.retry = setTimeout(() => {
      this.retry = null;
      void this.apply();
    }, RETRY_MS);
    this.retry.unref();
  }

  private async halt(): Promise<void> {
    const engine = this.engine;
    this.engine = null;
    this.desk?.detach();
    if (engine) await engine.stop().catch((error: unknown) => this.ctx.log.warn(`Sync did not stop cleanly: ${describeError(error)}`));
  }

  /** At quit. */
  stop(): Promise<void> {
    this.stopped = true;
    if (this.retry) clearTimeout(this.retry);
    this.retry = null;
    return this.enqueue(() => this.halt());
  }

  /** Agents, skills, workspaces or CLIs changed: the synced agents and skills are looked at again. */
  libraryChanged(): void {
    if (this.engine) this.desk?.libraryChanged();
  }

  /** What runs in the workspaces changed: the paired machines are told. */
  liveChanged(): void {
    if (this.engine) this.desk?.setLive();
  }

  /**
   * Fetches the pinned Syncthing into this copy (a git checkout, or one built from source; the
   * ready-made build has it inside). Run with Electron's own Node, so it needs nothing on PATH.
   */
  install(): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [path.join(this.ctx.appRoot, "scripts", "fetch-syncthing.mjs"), "--quiet"], {
        cwd: this.ctx.appRoot,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
        stdio: ["ignore", "ignore", "pipe"],
      });
      let said = "";
      child.stderr.setEncoding("utf8").on("data", (chunk: string) => (said += chunk));
      child.once("error", (error) => reject(new Error(`The sync engine could not be downloaded: ${error.message}`)));
      child.once("exit", (code) => {
        if (code === 0) {
          this.ctx.log.info(`Sync: fetched Syncthing ${this.engineVersion()}`);
          void this.apply().then(resolve, resolve);
        } else reject(new Error(`The sync engine could not be downloaded: ${said.replace(/^✗\s*/, "").trim().split("\n").pop() || `exit code ${code}`}`));
      });
    });
  }

  async view(): Promise<SyncView> {
    const service = this.ctx.service;
    const base: SyncView = { ...EMPTY_SYNC_VIEW, available: fs.existsSync(this.binary()), enabled: service?.getSettings().sync.enabled ?? false, running: Boolean(this.engine), error: this.error, engineVersion: this.engineVersion() };
    if (!service) return base;
    const desk = this.makeDesk();
    const engine = this.engine;
    return {
      ...base,
      firewall: engine ? this.firewall() : null,
      me: engine ? { id: engine.id, name: service.getSettings().sync.name || os.hostname(), code: desk.code(engine.id) } : null,
      ...(await desk.view()),
    };
  }

  // What the window asks for; each is the desk's own.

  addMachine = (code: string): Promise<void> => this.makeDesk().addMachine(code);
  acceptRequest = (id: string): Promise<void> => this.makeDesk().acceptRequest(id);
  ignoreRequest = (id: string): Promise<void> => this.makeDesk().ignoreRequest(id);
  removeMachine = (id: string): Promise<void> => this.makeDesk().removeMachine(id);
  share = (workspaceId: string, machineId: string, options: { mode: SyncMode; filesOnly: boolean }): Promise<void> => this.makeDesk().share(workspaceId, machineId, options);
  updateShare = (folderId: string, options: { mode: SyncMode; filesOnly: boolean }): Promise<void> => this.makeDesk().updateShare(folderId, options);
  stopShare = (folderId: string): Promise<void> => this.makeDesk().stopShare(folderId);
  acceptOffer = (folderId: string, folder: string): Promise<void> => this.makeDesk().acceptOffer(folderId, folder);
  declineOffer = (folderId: string): Promise<void> => this.makeDesk().declineOffer(folderId);
  conflictDiff = (id: string): Promise<string> => this.makeDesk().conflictDiff(id);
  resolveConflict = (id: string, keep: "mine" | "theirs"): Promise<void> => this.makeDesk().resolveConflict(id, keep);
  mergeConflict = (id: string): Promise<MergeResult> => this.makeDesk().mergeConflict(id);
  library = (): LibraryView => this.makeDesk().libraryView();
  setLibrarySync = (kind: ItemKind, id: string, on: boolean): Promise<void> => this.makeDesk().setLibrarySync(kind, id, on);
  placeAgentFolder = (agentId: string, key: string, folder: string): Promise<void> => this.makeDesk().placeAgentFolder(agentId, key, folder);
}
