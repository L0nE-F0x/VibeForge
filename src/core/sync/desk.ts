import fs from "node:fs";
import path from "node:path";
import { isDirectory } from "../fsx.js";
import { slugify } from "../slug.js";
import type { LiveSession, Workspace } from "../types.js";
import { ConflictStore, copiesIn, walkCopies, type ConflictRecord, type FoundCopy } from "./conflicts.js";
import { inHistory, mergeSaved, prepareRepo, repoKind, rescueRepo, type MergeResult } from "./git-rescue.js";
import { DELETE_GRACE_MS, LibrarySync, type ItemKind, type LibraryHost, type LibraryView, type Peer } from "./library.js";
import { buildLink, readLink, safeHint, settleWithLink, writeLink, type LinkOffer } from "./link.js";
import { deviceId, dialAddress, folderType, hostPort, ignoreLines, isOurFolder, linkFolderId, mergeIgnoreFile, newFolderId, pairingCode, parsePairingCode, shortId, SYNC_PORT, withoutIgnoreBlock, type SyncMode } from "./protocol.js";
import { SyncStateFile, type MachineRecord, type ShareRecord, type SyncState } from "./state.js";
import type { EngineEvent, EngineFolder, ShareState, SyncConflict, SyncEngine, SyncMachine, SyncOffer, SyncRequest, SyncShare } from "./types.js";

// Sync, as VibeForge sees it: which machines are paired, which workspaces go to which machine and
// how, what the other machine offers, and what to do when both changed the same thing. The engine
// underneath (a private Syncthing) only moves files; everything a person decides is kept here, in
// `<data>/sync/state.json`, and the engine is made to match it.

/** What the desk needs from the app around it. */
export interface SyncDeskHost {
  home: string;
  /** This machine's name, as the other machine shows it. */
  machineName(): string;
  /** Where this machine can be reached (`host:port`), for its pairing code. */
  addresses(): string[];
  workspaces(): Workspace[];
  /** Makes `folder` a workspace called `name`, without switching to it. */
  addWorkspace(folder: string, name: string): void;
  live(): LiveSession[];
  notify(note: { title: string; body: string }): void;
  /** Something the window shows about sync changed. */
  changed(): void;
  log(line: string): void;
  /** Saved agents and skills, for syncing the ones a person turns on. Without it, only workspaces sync. */
  library?: LibraryHost;
}

export interface SyncDeskView {
  machines: SyncMachine[];
  requests: SyncRequest[];
  offers: SyncOffer[];
  shares: SyncShare[];
  conflicts: SyncConflict[];
}

/** How long changes are gathered before the folders they touched are looked at for conflict copies. */
const SWEEP_MS = 1500;
/** Seconds Syncthing waits after a change before sending it: long enough for a burst of writes to go as one. */
const WORKSPACE_DELAY = 5;
const LINK_DELAY = 1;
/** After unpairing, how long the other machine's attempts to connect are not shown as a request to pair. */
const UNPAIR_QUIET_MS = 5 * 60 * 1000;

const inside = (parent: string, child: string): boolean => {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
};

export class SyncDesk {
  private readonly stateFile: SyncStateFile;
  readonly conflicts: ConflictStore;
  /** Synced agents and skills (./library.ts); null when the app gave no library. */
  private readonly library: LibrarySync | null;
  private engine: SyncEngine | null = null;
  /** One change at a time: two clicks, or a click and something arriving, never interleave. */
  private chain: Promise<unknown> = Promise.resolve();
  private readonly offers = new Map<string, { machineId: string; offer: LinkOffer }>();
  private readonly peerLive = new Map<string, string[]>();
  /** Shares the other machine has taken up. */
  private readonly accepted = new Set<string>();
  private readonly dirs = new Map<string, Set<string>>();
  /** Folders whose `.git` saw updates and wait for Syncthing idle + need=0 before rescue. */
  private readonly gitPending = new Set<string>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly told = new Set<string>();
  private live: Record<string, string[]> = {};
  /** Shares whose folder is missing here. */
  private readonly missing = new Set<string>();
  /** How long unpairing waits for its last note to reach a machine that is connected. Tests shorten it. */
  unpairWaitMs = 2500;
  /** Machines just unpaired here, and until when their still dialling in is not taken for a new request. */
  private readonly quiet = new Map<string, number>();

  constructor(
    private readonly dataRoot: string,
    private readonly host: SyncDeskHost,
    now: () => Date = () => new Date(),
    /** Seconds a workspace's change waits before it is sent. Tests shorten it. */
    private readonly workspaceDelay = WORKSPACE_DELAY,
  ) {
    this.stateFile = new SyncStateFile(path.join(dataRoot, "sync", "state.json"));
    this.conflicts = new ConflictStore(path.join(dataRoot, "sync", "conflicts"), now);
    this.library = host.library ? new LibrarySync(dataRoot, host.library, this.conflicts, now) : null;
  }

  /** Where the private Syncthing keeps its keys, settings and index. */
  get engineHome(): string {
    return path.join(this.dataRoot, "sync", "engine");
  }

  private linkDir(machineId: string): string {
    return path.join(this.dataRoot, "sync", "link", shortId(machineId));
  }

  private run<T>(job: () => Promise<T>): Promise<T> {
    const next = this.chain.then(job, job);
    this.chain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  /** Resolves once everything queued so far has finished. */
  settled(): Promise<void> {
    return this.chain.then(() => undefined);
  }

  private need(): SyncEngine {
    if (!this.engine) throw new Error("Sync is not running. Turn it on in Settings.");
    return this.engine;
  }

  // ------------------------------------------------------------------ start and stop

  /** The engine is up: make it match what is saved, then catch up on what the other machines say. */
  attach(engine: SyncEngine): Promise<void> {
    return this.run(async () => {
      this.engine = engine;
      this.conflicts.tidy();
      await this.reconcile();
      await this.readLinks();
      this.library?.setMe(shortId(engine.id));
      await this.libraryPass(true);
      for (const share of this.stateFile.read().shares) {
        if (isDirectory(share.path)) await this.handleCopies(share, walkCopies(share.path));
      }
      this.host.changed();
    });
  }

  /** The engine is gone (sync turned off, or VibeForge quitting). What is saved stays. */
  detach(): void {
    this.engine = null;
    this.library?.setMe("");
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.dirs.clear();
    this.gitPending.clear();
    this.offers.clear();
    this.peerLive.clear();
    this.accepted.clear();
  }

  // ------------------------------------------------------------------ making the engine match

  private async reconcile(): Promise<void> {
    const engine = this.engine;
    if (!engine) return;
    const state = this.stateFile.read();
    await engine.setName(this.host.machineName());

    const devices = await engine.devices();
    for (const machine of state.machines) {
      const wanted = { id: machine.id, name: machine.name, addresses: ["dynamic", ...machine.addresses.map(dialAddress)] };
      const have = devices.find((device) => device.id === machine.id);
      if (!have || have.name !== wanted.name || have.addresses.join(",") !== wanted.addresses.join(",")) await engine.putDevice(wanted);
    }

    const wanted = new Map<string, EngineFolder>();
    for (const machine of state.machines) {
      const dir = this.linkDir(machine.id);
      fs.mkdirSync(dir, { recursive: true });
      wanted.set(linkFolderId(engine.id, machine.id), { id: linkFolderId(engine.id, machine.id), label: "VibeForge link", path: dir, type: "sendreceive", devices: [machine.id], watchDelay: LINK_DELAY });
    }
    this.missing.clear();
    for (const share of state.shares) {
      if (!isDirectory(share.path)) {
        this.missing.add(share.folderId);
        continue;
      }
      const ignoreFile = path.join(share.path, ".stignore");
      const before = fs.existsSync(ignoreFile) ? fs.readFileSync(ignoreFile, "utf8") : "";
      const after = mergeIgnoreFile(before, ignoreLines({ filesOnly: share.filesOnly }));
      if (after !== before) fs.writeFileSync(ignoreFile, after);
      if (!share.filesOnly) await prepareRepo(share.path);
      wanted.set(share.folderId, { id: share.folderId, label: share.name, path: share.path, type: folderType(share.mode), devices: [share.machineId], watchDelay: this.workspaceDelay });
    }

    const folders = await engine.folders();
    for (const folder of folders) {
      if (!isOurFolder(folder.id) || wanted.has(folder.id)) continue;
      await engine.removeFolder(folder.id);
      if (folder.id.startsWith("vf-ws-")) this.unmark(folder.path);
    }
    for (const folder of wanted.values()) {
      const have = folders.find((item) => item.id === folder.id);
      const same = have && have.path === folder.path && have.type === folder.type && have.label === folder.label && have.watchDelay === folder.watchDelay && have.devices.join(",") === folder.devices.join(",");
      if (!same) await engine.putFolder(folder);
    }
    // After the folders, so a machine being removed has nothing shared with it any more.
    for (const device of devices) {
      if (device.id !== engine.id && !state.machines.some((machine) => machine.id === device.id)) await engine.removeDevice(device.id);
    }
    this.publish();
  }

  /** Takes VibeForge's marks out of a folder that no longer syncs. Its files stay as they are. */
  private unmark(folder: string): void {
    try {
      const file = path.join(folder, ".stignore");
      if (fs.existsSync(file)) {
        const rest = withoutIgnoreBlock(fs.readFileSync(file, "utf8"));
        if (rest) fs.writeFileSync(file, rest);
        else fs.rmSync(file, { force: true });
      }
      fs.rmSync(path.join(folder, ".stfolder"), { recursive: true, force: true });
    } catch (error) {
      this.host.log(`Sync: could not tidy ${folder}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** Writes what this machine tells each paired one, when it changed. */
  private publish(): void {
    const engine = this.engine;
    if (!engine) return;
    const state = this.stateFile.read();
    for (const machine of state.machines) {
      const link = buildLink({ id: engine.id, name: this.host.machineName() }, state, machine.id, this.live, this.host.home);
      try {
        fs.mkdirSync(this.linkDir(machine.id), { recursive: true });
        writeLink(path.join(this.linkDir(machine.id), `${engine.id}.json`), link);
      } catch (error) {
        this.host.log(`Sync: could not write the note for ${machine.name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  /** Reads what each paired machine says and follows it: stops, mode changes, offers, what runs there. */
  private async readLinks(): Promise<void> {
    const engine = this.engine;
    if (!engine) return;
    let again = false;
    for (const machine of this.stateFile.read().machines) {
      const link = readLink(path.join(this.linkDir(machine.id), `${machine.id}.json`), machine.id);
      if (!link) continue;
      if (link.gone) {
        // It unpaired: the same happens here, without asking it again.
        await this.forget(machine.id);
        this.host.notify({ title: "VibeForge", body: `${link.name || machine.name} unpaired from this machine. What synced with it has stopped; the files stay.` });
        continue;
      }
      const settled = settleWithLink(this.stateFile.read(), engine.id, machine.id, link);
      let state = settled.state;
      let changed = settled.changed;
      if (link.name && link.name !== machine.name) {
        state = { ...state, machines: state.machines.map((item) => (item.id === machine.id ? { ...item, name: link.name } : item)) };
        changed = true;
      }
      if (changed) {
        this.stateFile.write(state);
        again = true;
      }
      for (const asked of settled.widened) {
        const key = `widen:${asked.share.folderId}:${asked.rev}`;
        if (this.told.has(key)) continue;
        this.told.add(key);
        const what = asked.mode !== asked.share.mode ? (asked.mode === "two" ? "both ways" : asked.mode === "receive" ? "only from it to this machine" : "only from this machine to it") : "with its git history";
        this.host.notify({
          title: "VibeForge",
          body: `${link.name || machine.name} changed ${asked.share.name} to sync ${what}. It isn't changed here: to agree, change it in Settings → Sync on this machine.`,
        });
        this.host.log(`Sync: kept ${asked.share.name} as it was; ${machine.id.slice(0, 7)} asked to widen it.`);
      }
      for (const share of settled.ended) {
        this.conflicts.forgetFolder(share.folderId);
        this.host.notify({ title: "VibeForge", body: `${link.name || machine.name} stopped syncing ${share.name}. Its files stay on this machine.` });
      }
      for (const key of [...this.offers.keys()]) if (this.offers.get(key)?.machineId === machine.id) this.offers.delete(key);
      for (const offer of settled.offers) {
        this.offers.set(offer.folderId, { machineId: machine.id, offer });
        if (!this.told.has(`offer:${offer.folderId}`)) {
          this.told.add(`offer:${offer.folderId}`);
          this.host.notify({ title: "VibeForge", body: `${link.name || machine.name} wants to sync ${offer.name} with this machine. Answer in Code, above the workspaces.` });
        }
      }
      for (const share of state.shares.filter((item) => item.machineId === machine.id)) {
        if (link.shares[share.folderId]) this.accepted.add(share.folderId);
        else this.accepted.delete(share.folderId);
        this.peerLive.set(share.folderId, link.live[share.folderId] ?? []);
      }
    }
    if (again) await this.reconcile();
  }

  // ------------------------------------------------------------------ what the engine says

  /** One thing the engine reported. Never throws: a failure is logged. */
  onEvent(event: EngineEvent): void {
    const engine = this.engine;
    if (!engine) return;
    if (event.type === "item-finished") {
      const state = this.stateFile.read();
      if (state.machines.some((machine) => linkFolderId(engine.id, machine.id) === event.folder)) {
        if (event.item.startsWith("library/") || event.item === "library") this.later("library", 300, () => this.libraryPass(true));
        else this.later("links", 200, () => this.readLinks());
        return;
      }
      const share = state.shares.find((item) => item.folderId === event.folder);
      if (!share) return;
      const set = this.dirs.get(share.folderId) ?? new Set<string>();
      if (event.item === ".git" || event.item.startsWith(".git/")) this.gitPending.add(share.folderId);
      else set.add(path.dirname(path.join(share.path, event.item)));
      this.dirs.set(share.folderId, set);
      this.later(`sweep:${share.folderId}`, SWEEP_MS, () => this.sweep(share.folderId));
      return;
    }
    if ((event.type === "folder-state" && event.state === "idle") || event.type === "folder-summary") {
      if (this.gitPending.has(event.folder)) this.later(`sweep:${event.folder}`, 50, () => this.sweep(event.folder));
    }
    if (event.type === "connected") this.later("links", 200, () => this.readLinks());
    if (event.type === "pending-devices") this.later("requests", 200, () => this.tellRequests());
    this.later("changed", 150, async () => this.host.changed());
  }

  private later(key: string, ms: number, job: () => Promise<void>): void {
    const running = this.timers.get(key);
    // The window is told at most every so often, not once things go quiet: a long sync never goes quiet.
    if (running && key === "changed") return;
    if (running) clearTimeout(running);
    const timer = setTimeout(() => {
      this.timers.delete(key);
      void this.run(job)
        .then(() => (key === "changed" ? undefined : this.host.changed()))
        .catch((error: unknown) => this.host.log(`Sync: ${key} failed: ${error instanceof Error ? error.message : String(error)}`));
    }, ms);
    timer.unref();
    this.timers.set(key, timer);
  }

  private async tellRequests(): Promise<void> {
    for (const request of await this.requests()) {
      if (this.told.has(`pair:${request.id}`)) continue;
      this.told.add(`pair:${request.id}`);
      this.host.notify({ title: "VibeForge", body: `${request.name} wants to sync with this machine. Answer in Settings, under Sync.` });
    }
  }

  private async requests(): Promise<SyncRequest[]> {
    const engine = this.engine;
    if (!engine) return [];
    const state = this.stateFile.read();
    const asking = [];
    for (const request of await engine.pendingDevices()) {
      if (state.ignored.includes(request.id) || state.machines.some((machine) => machine.id === request.id)) continue;
      if ((this.quiet.get(request.id) ?? 0) > Date.now()) {
        // It hadn't heard of the unpairing yet. Dropped, so it only counts if it asks again later.
        void engine.dismissPendingDevice(request.id).catch(() => undefined);
        continue;
      }
      asking.push(request);
    }
    return asking;
  }

  /** Looks where files just arrived for copies of files both machines changed, and takes them in. */
  private async sweep(folderId: string): Promise<void> {
    const share = this.stateFile.read().shares.find((item) => item.folderId === folderId);
    const dirs = [...(this.dirs.get(folderId) ?? [])];
    this.dirs.delete(folderId);
    if (!share || !isDirectory(share.path)) return;
    await this.handleCopies(share, dirs.flatMap((dir) => copiesIn(dir)));
  }

  private async handleCopies(share: ShareRecord, copies: FoundCopy[]): Promise<void> {
    let fresh: ConflictRecord | null = null;
    const repo = !share.filesOnly && repoKind(share.path) === "repo";
    let gitSettled = true;
    if (repo && this.engine) {
      const status = await this.engine.folderStatus(share.folderId).catch(() => null);
      gitSettled = status?.state === "idle" && status.need === 0;
    }
    if (repo && gitSettled) {
      this.gitPending.delete(share.folderId);
      await prepareRepo(share.path);
      try {
        const rescue = await rescueRepo(share.path, slugify(this.host.machineName(), 24));
        for (const branch of rescue?.branches ?? []) fresh = this.conflicts.noteCommits(share.folderId, share.path, branch.branch, branch.saved, shortId(share.machineId));
        if (rescue) this.host.log(`Sync: both machines changed ${share.name}'s git history; ${rescue.branches.length} branch(es) kept aside, ${rescue.settled.length} file(s) put back, ${rescue.removed} copies removed`);
      } catch (error) {
        this.host.log(`Sync: could not sort out ${share.name}'s git history: ${error instanceof Error ? error.message : String(error)}`);
      }
    } else if (repo) {
      this.gitPending.add(share.folderId);
    }
    for (const copy of copies) {
      if (!fs.existsSync(copy.file)) continue;
      try {
        const original = path.relative(share.path, path.join(path.dirname(copy.file), copy.name.original)).split(path.sep).join("/");
        // A copy of a committed version is that commit's file again: nothing to ask about.
        if (repo && (await inHistory(share.path, copy.file, original))) {
          fs.rmSync(copy.file, { force: true });
          continue;
        }
        fresh = this.conflicts.keepFile(share.folderId, share.path, copy) ?? fresh;
      } catch (error) {
        this.host.log(`Sync: could not take in a conflict copy in ${share.name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (!fresh) return;
    const machine = this.stateFile.read().machines.find((item) => item.id === share.machineId)?.name ?? "the other machine";
    this.host.notify({
      title: share.name,
      body:
        fresh.kind === "commits"
          ? `Both machines committed on ${fresh.path}. This machine's commits are kept on ${fresh.savedBranch}.`
          : `${fresh.path} changed on both machines. ${machine}'s version is in the workspace; this machine's is kept safe.`,
    });
  }

  // ------------------------------------------------------------------ what runs here

  /** Tells the paired machines what is running in each shared workspace now. */
  setLive(): void {
    const next: Record<string, string[]> = {};
    const sessions = this.host.live();
    for (const share of this.stateFile.read().shares) {
      const labels = sessions.filter((session) => inside(share.path, session.programCwd || session.cwd)).map((session) => session.program || (session.kind === "shell" ? "Shell" : session.title));
      if (labels.length) next[share.folderId] = [...new Set(labels)].sort();
    }
    if (JSON.stringify(next) === JSON.stringify(this.live)) return;
    this.live = next;
    if (this.engine) void this.run(async () => this.publish());
  }

  // ------------------------------------------------------------------ machines

  /** This machine's pairing code, for the other one to paste. */
  code(id: string): string {
    return pairingCode(id, this.host.addresses());
  }

  /** Pairs with the machine whose code was pasted. It still has to say yes on its side (or paste this one's). */
  addMachine(code: string): Promise<void> {
    return this.run(async () => {
      const engine = this.need();
      const parsed = parsePairingCode(code);
      if (!parsed) throw new Error("That is not a sync code. Copy it from the other machine's Settings, under Sync.");
      if (parsed.id === engine.id) throw new Error("That is this machine's own code. Paste the other machine's.");
      this.quiet.delete(parsed.id);
      this.stateFile.update((state) => {
        const known = state.machines.find((machine) => machine.id === parsed.id);
        if (known) known.addresses = [...new Set([...parsed.addresses, ...known.addresses])].slice(0, 8);
        else state.machines.push({ id: parsed.id, name: shortId(parsed.id), addresses: parsed.addresses });
        state.ignored = state.ignored.filter((id) => id !== parsed.id);
        return state;
      });
      await engine.dismissPendingDevice(parsed.id).catch(() => undefined);
      await this.reconcile();
      this.host.changed();
    });
  }

  /** Says yes to a machine that asked to pair. */
  acceptRequest(id: string): Promise<void> {
    return this.run(async () => {
      const request = (await this.requests()).find((item) => item.id === id);
      if (!request) throw new Error("That machine is no longer asking.");
      // It dials out from the port it listens on, unless that port was taken.
      const [host, port] = splitAddress(request.address);
      const address = host ? hostPort(`${host.includes(":") ? `[${host}]` : host}:${port && port < 32768 ? port : SYNC_PORT}`) : null;
      this.stateFile.update((state) => {
        state.machines.push({ id: request.id, name: request.name || shortId(request.id), addresses: address ? [address] : [] });
        return state;
      });
      await this.engine?.dismissPendingDevice(request.id).catch(() => undefined);
      await this.reconcile();
      this.host.changed();
    });
  }

  ignoreRequest(id: string): Promise<void> {
    return this.run(async () => {
      this.stateFile.update((state) => {
        if (!state.ignored.includes(id)) state.ignored.push(id);
        return state;
      });
      await this.engine?.dismissPendingDevice(id).catch(() => undefined);
      this.host.changed();
    });
  }

  /** Unpairs a machine. Everything synced with it stops; the files stay on both. The other machine is told, when it can be. */
  removeMachine(id: string): Promise<void> {
    return this.run(async () => {
      const valid = deviceId(id);
      if (!valid) return;
      const engine = this.engine;
      const state = this.stateFile.read();
      const machine = state.machines.find((item) => item.id === valid);
      if (!machine) return;
      if (engine) {
        // A last note, so the other machine unpairs too instead of waiting for one that never comes back.
        try {
          const last = { ...buildLink({ id: engine.id, name: this.host.machineName() }, { ...state, shares: [] }, valid, {}, this.host.home), stopped: state.shares.filter((share) => share.machineId === valid).map((share) => share.folderId), gone: true };
          writeLink(path.join(this.linkDir(valid), `${engine.id}.json`), last);
          const connected = (await engine.connections().catch(() => ({}) as Awaited<ReturnType<SyncEngine["connections"]>>))[valid]?.connected;
          if (connected && this.unpairWaitMs > 0) await new Promise((resolve) => setTimeout(resolve, this.unpairWaitMs));
        } catch (error) {
          this.host.log(`Sync: could not tell ${machine.name} about unpairing: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      this.quiet.set(valid, Date.now() + UNPAIR_QUIET_MS);
      await this.forget(valid);
      this.host.changed();
    });
  }

  /** Drops a machine and everything shared with it. */
  private async forget(id: string): Promise<void> {
    if (!deviceId(id)) return;
    for (const share of this.stateFile.read().shares.filter((item) => item.machineId === id)) {
      this.conflicts.forgetFolder(share.folderId);
      this.peerLive.delete(share.folderId);
      this.accepted.delete(share.folderId);
    }
    this.stateFile.update((next) => {
      next.shares = next.shares.filter((share) => share.machineId !== id);
      next.machines = next.machines.filter((machine) => machine.id !== id);
      for (const [folderId, told] of Object.entries(next.stopped)) if (told === id) delete next.stopped[folderId];
      return next;
    });
    for (const key of [...this.offers.keys()]) if (this.offers.get(key)?.machineId === id) this.offers.delete(key);
    await this.reconcile();
    fs.rmSync(this.linkDir(id), { recursive: true, force: true });
  }

  // ------------------------------------------------------------------ shares

  private checkFolder(state: SyncState, folder: string, except?: string): void {
    const resolved = path.resolve(folder);
    if (resolved === path.parse(resolved).root || inside(resolved, this.host.home)) throw new Error("Choose a project's own folder, not your home folder or one that holds it.");
    const fromHome = path.relative(this.host.home, resolved);
    if (fromHome && !fromHome.startsWith("..") && !path.isAbsolute(fromHome) && fromHome.split(path.sep)[0].startsWith(".")) {
      throw new Error("Choose a project folder, not a hidden folder in your home directory.");
    }
    for (const share of state.shares) {
      if (share.folderId === except) continue;
      if (share.path === resolved) throw new Error("This folder already syncs with a machine.");
      if (inside(share.path, resolved) || inside(resolved, share.path)) throw new Error("A folder inside another synced folder can't sync on its own.");
    }
    // A folder that holds other workspaces (~/Projects, say) would send or take all of them at once.
    const holds = this.host.workspaces().filter((item) => path.resolve(item.path) !== resolved && inside(resolved, path.resolve(item.path)));
    if (holds.length) {
      throw new Error(`This folder holds other workspaces (${holds.slice(0, 3).map((item) => item.name).join(", ")}${holds.length > 3 ? ", …" : ""}). Choose a project's own folder.`);
    }
  }

  /** Starts syncing a workspace with a paired machine, which is offered it. */
  share(workspaceId: string, machineId: string, options: { mode: SyncMode; filesOnly: boolean }): Promise<void> {
    return this.run(async () => {
      this.need();
      const workspace = this.host.workspaces().find((item) => item.id === workspaceId);
      if (!workspace) throw new Error("That workspace is gone.");
      if (!isDirectory(workspace.path)) throw new Error("That folder does not exist any more.");
      const state = this.stateFile.read();
      if (!state.machines.some((machine) => machine.id === machineId)) throw new Error("That machine is not paired with this one.");
      this.checkFolder(state, workspace.path);
      // A branch opened as its own folder keeps its history in the repository beside it: nothing to send.
      const filesOnly = options.filesOnly || repoKind(workspace.path) === "checkout";
      this.stateFile.update((next) => {
        next.shares.push({ folderId: newFolderId(), machineId, path: path.resolve(workspace.path), name: workspace.name, mode: options.mode, filesOnly, rev: 1 });
        return next;
      });
      await this.reconcile();
      this.setLive();
      this.host.changed();
    });
  }

  /** Changes how a share syncs. The other machine follows. */
  updateShare(folderId: string, options: { mode: SyncMode; filesOnly: boolean }): Promise<void> {
    return this.run(async () => {
      this.need();
      this.stateFile.update((state) => {
        const share = state.shares.find((item) => item.folderId === folderId);
        if (!share) throw new Error("That workspace no longer syncs.");
        const filesOnly = options.filesOnly || repoKind(share.path) === "checkout";
        if (share.mode !== options.mode || share.filesOnly !== filesOnly) {
          share.mode = options.mode;
          share.filesOnly = filesOnly;
          share.rev += 1;
        }
        return state;
      });
      await this.reconcile();
      this.host.changed();
    });
  }

  /** Stops syncing a workspace, on both machines. The files stay on both. */
  stopShare(folderId: string): Promise<void> {
    return this.run(async () => {
      const share = this.stateFile.read().shares.find((item) => item.folderId === folderId);
      if (!share) return;
      this.stateFile.update((state) => {
        state.shares = state.shares.filter((item) => item.folderId !== folderId);
        state.stopped[folderId] = share.machineId;
        return state;
      });
      this.conflicts.forgetFolder(folderId);
      this.peerLive.delete(folderId);
      this.accepted.delete(folderId);
      if (this.engine) await this.reconcile();
      else this.unmark(share.path);
      this.host.changed();
    });
  }

  /** Takes up a workspace another machine offered, in `folder` (made if it isn't there), and adds it as a workspace. */
  acceptOffer(folderId: string, folder: string): Promise<void> {
    return this.run(async () => {
      this.need();
      const found = this.offers.get(folderId);
      if (!found) throw new Error("That offer is gone.");
      if (!path.isAbsolute(folder)) throw new Error("Choose a folder that exists.");
      const target = path.resolve(folder);
      this.checkFolder(this.stateFile.read(), target);
      fs.mkdirSync(target, { recursive: true });
      this.stateFile.update((state) => {
        state.shares.push({ folderId, machineId: found.machineId, path: target, name: found.offer.name, mode: found.offer.mode, filesOnly: found.offer.filesOnly, rev: 1 });
        return state;
      });
      this.offers.delete(folderId);
      this.accepted.add(folderId);
      this.host.addWorkspace(target, found.offer.name);
      await this.reconcile();
      this.setLive();
      this.libraryChanged();
      this.host.changed();
    });
  }

  /** Says no to an offer. The other machine stops offering it. */
  declineOffer(folderId: string): Promise<void> {
    return this.run(async () => {
      const found = this.offers.get(folderId);
      if (!found) return;
      this.stateFile.update((state) => {
        state.stopped[folderId] = found.machineId;
        return state;
      });
      this.offers.delete(folderId);
      this.publish();
      this.host.changed();
    });
  }

  // ------------------------------------------------------------------ changed on both machines

  /** What putting this machine's version back would change. */
  conflictDiff(id: string): Promise<string> {
    const record = this.conflicts.get(id);
    if (record && (record.kind === "agent" || record.kind === "skill")) return this.conflicts.diff(id, this.library?.current(record) ?? "");
    return this.conflicts.diff(id);
  }

  /** Answers a conflict: "mine" puts this machine's version back; "theirs" keeps what is there. */
  resolveConflict(id: string, keep: "mine" | "theirs"): Promise<void> {
    return this.run(async () => {
      const waiting = this.conflicts.get(id);
      if (waiting && (waiting.kind === "agent" || waiting.kind === "skill") && keep === "mine") {
        if (!this.library) throw new Error("Sync is not running. Turn it on in Settings.");
        this.library.restore(waiting, this.conflicts.savedText(id));
      }
      const record = this.conflicts.resolve(id, keep);
      if (record && (record.kind === "agent" || record.kind === "skill") && keep === "mine") await this.libraryPass(false);
      // Syncthing notices by itself within seconds; asking makes it now.
      if (record?.kind === "file" && keep === "mine") await this.engine?.scan(record.folderId, record.path).catch(() => undefined);
      this.host.changed();
    });
  }

  /** Merges the branch this machine's commits were kept on into the one checked out. */
  mergeConflict(id: string): Promise<MergeResult> {
    return this.run(async () => {
      const record = this.conflicts.get(id);
      if (!record || record.kind !== "commits" || !record.savedBranch) throw new Error("That is no longer waiting.");
      const result = await mergeSaved(record.root, record.savedBranch);
      // Merged, or stopped on files for a person or a CLI to finish: either way it is git's now.
      if (!result.refused) this.conflicts.resolve(id, "theirs");
      this.host.changed();
      return result;
    });
  }

  // ------------------------------------------------------------------ agents and skills

  private peers(): Peer[] {
    return this.stateFile.read().machines.map((machine) => ({ id: machine.id, name: machine.name, dir: this.linkDir(machine.id) }));
  }

  /**
   * One look at the synced agents and skills: what the other machines say (`remote`), then what
   * changed here, then this machine's files for them written out. A delete here waiting for its
   * Undo to run out is looked at again then.
   */
  private async libraryPass(remote: boolean): Promise<void> {
    const library = this.library;
    const engine = this.engine;
    if (!library || !engine) return;
    const state = this.stateFile.read();
    library.setPlaces({ home: this.host.home, workspaces: this.host.workspaces(), shares: state.shares.map((share) => ({ folderId: share.folderId, path: share.path })) });
    if (remote) await library.receive(this.peers());
    const { recheck } = library.scan();
    library.publish(engine.id, this.peers());
    if (recheck) this.later("library-local", DELETE_GRACE_MS, () => this.libraryPass(false));
  }

  /** Agents, skills, workspaces or CLIs changed here: the synced ones are looked at again shortly. */
  libraryChanged(): void {
    if (this.engine && this.library) this.later("library-local", 800, () => this.libraryPass(false));
  }

  /** Turns syncing an agent or a skill on or off. The other machines follow. */
  setLibrarySync(kind: ItemKind, localId: string, on: boolean): Promise<void> {
    return this.run(async () => {
      this.need();
      const library = this.library;
      if (!library) throw new Error("Agents and skills can't sync in this copy.");
      const state = this.stateFile.read();
      if (on && !state.machines.length) throw new Error("Pair a machine first, in Settings, under Sync.");
      library.setPlaces({ home: this.host.home, workspaces: this.host.workspaces(), shares: state.shares.map((share) => ({ folderId: share.folderId, path: share.path })) });
      library.setOn(kind, localId, on);
      await this.libraryPass(false);
      this.host.changed();
    });
  }

  /** Uses `folder` on this machine for one of a synced agent's folders that wasn't found here. */
  placeAgentFolder(agentId: string, key: string, folder: string): Promise<void> {
    return this.run(async () => {
      this.need();
      if (!path.isAbsolute(folder) || !isDirectory(folder)) throw new Error("Choose a folder that exists.");
      this.library?.placeAt(agentId, key, folder);
      await this.libraryPass(false);
      this.host.changed();
    });
  }

  /** Which agents and skills sync, and what each is waiting for here. */
  libraryView(): LibraryView {
    return this.library?.view() ?? { agents: {}, skills: {} };
  }

  // ------------------------------------------------------------------ for the window

  async view(): Promise<SyncDeskView> {
    const state = this.stateFile.read();
    const engine = this.engine;
    const workspaces = this.host.workspaces();
    const workspaceFor = (folder: string) => workspaces.find((item) => path.resolve(item.path) === folder)?.id ?? null;
    const nameOf = (id: string) => state.machines.find((machine) => machine.id === id)?.name ?? shortId(id);
    const waiting = this.conflicts.list();
    const conflicts: SyncConflict[] = waiting.map((record) => ({
      id: record.id,
      folderId: record.folderId,
      workspaceId: workspaceFor(record.root),
      kind: record.kind,
      path: record.path,
      section: record.section ?? null,
      itemId: record.itemId ?? null,
      savedBranch: record.savedBranch,
      machineName: state.machines.find((machine) => shortId(machine.id) === record.winner)?.name ?? "the other machine",
      at: record.at,
    }));
    const connections = engine ? await engine.connections().catch(() => ({}) as Awaited<ReturnType<SyncEngine["connections"]>>) : {};
    const machines: SyncMachine[] = state.machines.map((machine: MachineRecord) => ({
      id: machine.id,
      name: machine.name,
      connected: connections[machine.id]?.connected ?? false,
      lastSeen: connections[machine.id]?.lastSeen ?? "",
    }));
    const shares: SyncShare[] = [];
    for (const share of state.shares) {
      const status = engine && !this.missing.has(share.folderId) ? await engine.folderStatus(share.folderId).catch(() => null) : null;
      let shown: ShareState = "synced";
      if (this.missing.has(share.folderId) || status?.state === "error" || (status?.errors ?? 0) > 0) shown = "error";
      else if (!this.accepted.has(share.folderId)) shown = "offered";
      else if (!connections[share.machineId]?.connected) shown = "away";
      else if (!status || status.need > 0 || /sync|scan/.test(status.state)) shown = "syncing";
      shares.push({
        folderId: share.folderId,
        workspaceId: workspaceFor(share.path),
        path: share.path,
        machineId: share.machineId,
        machineName: nameOf(share.machineId),
        mode: share.mode,
        filesOnly: share.filesOnly,
        state: shown,
        need: status?.need ?? 0,
        peerLive: this.peerLive.get(share.folderId) ?? [],
        conflicts: waiting.filter((record) => record.folderId === share.folderId).length,
      });
    }
    const taken = new Set(state.shares.map((share) => share.path));
    const offers: SyncOffer[] = [...this.offers.values()].map(({ machineId, offer }) => {
      const hint = safeHint(offer.hint);
      let suggested = hint ? path.join(this.host.home, ...hint.split("/")) : path.join(this.host.home, "Projects", offer.name.replace(/[/\\]/g, "-"));
      if (taken.has(suggested)) suggested = `${suggested}-${shortId(machineId).toLowerCase()}`;
      let hasFiles = false;
      try {
        hasFiles = fs.readdirSync(suggested).length > 0;
      } catch {
        /* not there yet */
      }
      return { folderId: offer.folderId, machineId, machineName: nameOf(machineId), name: offer.name, mode: offer.mode, filesOnly: offer.filesOnly, suggestedPath: suggested, suggestedHasFiles: hasFiles };
    });
    return { machines, requests: await this.requests().catch(() => []), offers, shares, conflicts };
  }
}

/** `1.2.3.4:5678` or `[::1]:5678` as its host and port. */
function splitAddress(address: string): [string, number | null] {
  const at = address.lastIndexOf(":");
  if (at <= 0) return [address, null];
  const port = Number(address.slice(at + 1));
  return [address.slice(0, at).replace(/^\[|\]$/g, ""), Number.isInteger(port) ? port : null];
}
