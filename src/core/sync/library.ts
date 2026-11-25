import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { readJson, writeFileAtomic, writeJson } from "../fsx.js";
import { agentTier, oneLine } from "../store.js";
import type { Agent, AgentTier, Skill } from "../types.js";
import type { ConflictRecord, ConflictStore } from "./conflicts.js";
import { compareClocks, hashValue, joinClocks, later, mergeSet, mergeText, tick, type Clock, type Stamp } from "./library-merge.js";
import { pickEngine, placeLabel, portablePlace, readEngine, readPlace, resolvePlace, type LocalEngine, type PlaceContext, type PortableEngine, type PortablePlace } from "./places-match.js";

// Saved agents and skills that a person chose to sync, kept the same on every paired machine.
//
// Each machine writes one file per synced agent or skill into the private folder it keeps with
// each paired machine (`<link>/library/<its id>/<sync id>.json`), and only ever reads the other
// machine's files: Syncthing never sees two machines change one file, so it never makes a conflict
// copy here. What arrives is merged part by part (name, brief, memory, skills, folders, CLI…), each
// part with its own count of changes per machine, so a change to the brief on one machine and to
// the memory on the other never meet. Where both changed the same part, texts are merged line by
// line, sets keep what either added, and single values go to the later change.
//
// What this machine knows about each synced item, and the last version both machines agreed on,
// is in `<data>/sync/library/<sync id>.json`. The agent's own files stay as they are.

export type ItemKind = "agent" | "skill";
export type ItemState = "on" | "off" | "deleted";

const AGENT_SECTIONS = ["state", "name", "brief", "memory", "goodAt", "tier", "allowRoutines", "engine", "skills", "places"] as const;
const SKILL_SECTIONS = ["state", "name", "description", "body"] as const;
type SectionName = (typeof AGENT_SECTIONS)[number] | (typeof SKILL_SECTIONS)[number];
type SectionType = "text" | "memory" | "set" | "value";

const TYPE: Record<SectionName, SectionType> = {
  state: "value",
  name: "value",
  brief: "text",
  memory: "memory",
  goodAt: "value",
  tier: "value",
  allowRoutines: "value",
  engine: "value",
  skills: "set",
  places: "set",
  description: "value",
  body: "text",
};

/** One part as a machine last saw it. */
interface Section extends Stamp {
  value: unknown;
  v: Clock;
}

/** What this machine keeps about one synced item. */
interface Entry {
  syncId: string;
  kind: ItemKind;
  /** Its id on this machine; "" when it isn't here (deleted, or not made yet). */
  localId: string;
  sections: Partial<Record<SectionName, Section & { hash: string; base: unknown }>>;
  /** For an agent: the folder on this machine that each place (by key) was found at. */
  placeAt: Record<string, string>;
  /** For an agent: the CLI it was given here, which may stand in for the one it asks for. */
  engineUsed: string;
  /** The machine that first sent it here; "" when it was made here. */
  from: string;
  /** Other machines' texts this machine's merges replaced, so each of them keeps its own. */
  lost: LostNote[];
}

interface LostNote {
  section: SectionName;
  /** The start of the id of the machine whose version was replaced. */
  by: string;
  /** That version's fingerprint. */
  hash: string;
}

/** One machine's file for one item. */
export interface LibraryRecord {
  v: 1;
  kind: ItemKind;
  syncId: string;
  sections: Partial<Record<SectionName, Section>>;
  lost: LostNote[];
}

/** What the library needs from the app: the agents' and skills' own files, and the CLIs set up here. */
export interface LibraryHost {
  agents(): Agent[];
  /**
   * Null only when the agent isn't here. One that is there but can't be read (permissions, a disk
   * error, a hand edit that doesn't parse) throws, as getSkill and readMemory do: Sync must never
   * take it for deleted.
   */
  getAgent(id: string): Agent | null;
  /** Saves the agent as it is (no checks: its folders may not all be here). */
  saveAgent(agent: Agent): void;
  readMemory(id: string): string;
  writeMemory(id: string, text: string): void;
  skills(): Skill[];
  getSkill(id: string): Skill | null;
  saveSkill(skill: Skill): void;
  /** A free id for a new agent or skill of that name. */
  newId(kind: ItemKind, name: string): string;
  /** Moves an agent or skill to the trash, as a delete here does. */
  remove(kind: ItemKind, id: string): Promise<void>;
  engines(): LocalEngine[];
  defaultEngine(): string;
  /** An agent or skill arrived from another machine. */
  arrived(kind: ItemKind, name: string, machine: string): void;
  /** Agents or skills on this machine were changed by sync. */
  changed(kinds: ItemKind[]): void;
  log(line: string): void;
}

/** What the window is shown about one agent or skill. */
export interface LibraryItemView {
  /** Turned on (by a person, on either machine). */
  on: boolean;
  /** Syncs now: on, or (a skill) carried by a synced agent. */
  syncing: boolean;
  /** A skill: the synced agents that carry it. */
  via: string[];
  /** The machine it came from; "" when it was made here. */
  from: string;
  /** An agent: its folders that aren't on this machine. */
  waiting: Array<{ key: string; label: string; folderId: string }>;
  /** An agent whose CLI isn't installed here: the one it asks for and the one it uses instead. */
  engine: { wanted: string; using: string } | null;
}

export interface LibraryView {
  agents: Record<string, LibraryItemView>;
  skills: Record<string, LibraryItemView>;
}

export interface Peer {
  id: string;
  name: string;
  /** The private folder kept with that machine. */
  dir: string;
}

/** A text longer than this isn't sent or taken. */
const MAX_TEXT = 256 * 1024;
/** How long a deleted agent or skill waits before the other machines are told: Undo is 30 s. */
export const DELETE_GRACE_MS = 35_000;
const SYNC_ID = /^vf-(ag|sk)-[0-9a-f]{12}$/;
const SHORT = /^[A-Z2-7]{7}$/;

const sectionsOf = (kind: ItemKind): readonly SectionName[] => (kind === "agent" ? AGENT_SECTIONS : SKILL_SECTIONS);
const emptyOf = (type: SectionType): unknown => (type === "set" ? [] : type === "value" ? null : "");
const keyOf = (name: SectionName) => (name === "places" ? (item: unknown) => (item as PortablePlace).key : (item: unknown) => String(item));
/** A set in one order on every machine, so the same set always looks the same. */
const sorted = <T>(name: SectionName, items: readonly T[]): T[] => [...items].sort((a, b) => keyOf(name)(a).localeCompare(keyOf(name)(b)));

export function newSyncId(kind: ItemKind, random: () => Buffer = () => randomBytes(6)): string {
  return `vf-${kind === "agent" ? "ag" : "sk"}-${random().toString("hex").slice(0, 12)}`;
}

// ------------------------------------------------------------------ reading another machine's file

function readClock(value: unknown): Clock | null {
  if (!value || typeof value !== "object") return null;
  const out: Clock = {};
  const rows = Object.entries(value as Record<string, unknown>);
  if (rows.length > 64) return null;
  for (const [key, count] of rows) {
    if (!SHORT.test(key) || typeof count !== "number" || !Number.isInteger(count) || count < 0 || count > 1e9) return null;
    out[key] = count;
  }
  return out;
}

/** A part's value as it may be taken from another computer; undefined when it isn't one. */
function readValue(name: SectionName, value: unknown): unknown {
  const text = (max: number) => (typeof value === "string" && value.length <= max ? value : undefined);
  switch (name) {
    case "state":
      return value === "on" || value === "off" || value === "deleted" ? value : undefined;
    case "name": {
      const found = text(200)?.trim().slice(0, 120);
      return found || undefined;
    }
    case "brief":
    case "memory":
    case "body":
      return text(MAX_TEXT);
    case "goodAt":
      return typeof value === "string" ? oneLine(value) : undefined;
    case "description":
      return typeof value === "string" ? value.trim().slice(0, 2000) : undefined;
    case "tier":
      return typeof value === "string" ? agentTier(value) : undefined;
    case "allowRoutines":
      return typeof value === "boolean" ? value : undefined;
    case "engine":
      return readEngine(value) ?? undefined;
    case "skills":
      return Array.isArray(value) ? sorted(name, [...new Set(value.filter((item): item is string => typeof item === "string" && SYNC_ID.test(item) && item.startsWith("vf-sk-")))].slice(0, 200)) : undefined;
    case "places": {
      if (!Array.isArray(value)) return undefined;
      const seen = new Set<string>();
      const out: PortablePlace[] = [];
      for (const item of value.slice(0, 100)) {
        const place = readPlace(item);
        if (place && !seen.has(place.key)) {
          seen.add(place.key);
          out.push(place);
        }
      }
      return sorted(name, out);
    }
  }
}

/** Another machine's file for one item, checked part by part: it comes from another computer. Null when it isn't one. */
export function readRecord(file: string): LibraryRecord | null {
  const raw = readJson<Record<string, unknown> | null>(file, null);
  if (!raw || typeof raw !== "object" || raw.v !== 1) return null;
  const syncId = typeof raw.syncId === "string" ? raw.syncId : "";
  const kind = raw.kind === "agent" || raw.kind === "skill" ? raw.kind : null;
  if (!kind || !SYNC_ID.test(syncId) || syncId.slice(3, 5) !== (kind === "agent" ? "ag" : "sk")) return null;
  const sections: LibraryRecord["sections"] = {};
  const given = raw.sections && typeof raw.sections === "object" ? (raw.sections as Record<string, unknown>) : {};
  for (const name of sectionsOf(kind)) {
    const row = given[name] as Record<string, unknown> | undefined;
    if (!row || typeof row !== "object") continue;
    const v = readClock(row.v);
    const value = readValue(name, row.value);
    const at = typeof row.at === "string" && row.at.length <= 40 ? row.at : "";
    const by = typeof row.by === "string" && SHORT.test(row.by) ? row.by : "";
    if (!v || value === undefined || !by) continue;
    sections[name] = { value, v, at, by };
  }
  if (!sections.state) return null;
  const lost = (Array.isArray(raw.lost) ? raw.lost : [])
    .flatMap((item) => {
      const row = item as Partial<LostNote> | null;
      if (!row || !sectionsOf(kind).includes(row.section as SectionName) || typeof row.by !== "string" || !SHORT.test(row.by) || typeof row.hash !== "string" || !/^[0-9a-f]{24}$/.test(row.hash)) return [];
      return [{ section: row.section as SectionName, by: row.by, hash: row.hash }];
    })
    .slice(-50);
  return { v: 1, kind, syncId, sections, lost };
}

// ------------------------------------------------------------------ the library

export class LibrarySync {
  private readonly dir: string;
  private readonly entries = new Map<string, Entry>();
  private loaded = false;
  /** Local ids found missing, and since when: a delete is only told once Undo is over. */
  private readonly missingSince = new Map<string, number>();
  /** Each machine's files as last read, so an unchanged one isn't merged again. */
  private readonly seen = new Map<string, string>();
  private me = "";

  constructor(
    dataRoot: string,
    private readonly host: LibraryHost,
    private readonly conflicts: ConflictStore,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.dir = path.join(dataRoot, "sync", "library");
  }

  /** This machine, by the start of its sync id. */
  setMe(short: string): void {
    this.me = short;
  }

  // ---------------------------------------------------------------- what is kept here

  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    let names: string[] = [];
    try {
      names = fs.readdirSync(this.dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const entry = readJson<Entry | null>(path.join(this.dir, name), null);
      if (!entry || typeof entry !== "object" || !SYNC_ID.test(entry.syncId) || `${entry.syncId}.json` !== name) continue;
      if (entry.kind !== "agent" && entry.kind !== "skill") continue;
      this.entries.set(entry.syncId, {
        syncId: entry.syncId,
        kind: entry.kind,
        localId: typeof entry.localId === "string" ? entry.localId : "",
        sections: entry.sections && typeof entry.sections === "object" ? entry.sections : {},
        placeAt: entry.placeAt && typeof entry.placeAt === "object" ? entry.placeAt : {},
        engineUsed: typeof entry.engineUsed === "string" ? entry.engineUsed : "",
        from: typeof entry.from === "string" ? entry.from : "",
        lost: Array.isArray(entry.lost) ? entry.lost.slice(-50) : [],
      });
    }
  }

  private save(entry: Entry): void {
    fs.mkdirSync(this.dir, { recursive: true });
    writeJson(path.join(this.dir, `${entry.syncId}.json`), entry, { mode: 0o600 });
  }

  private all(kind?: ItemKind): Entry[] {
    this.load();
    return [...this.entries.values()].filter((entry) => !kind || entry.kind === kind);
  }

  private byLocal(kind: ItemKind, localId: string): Entry | undefined {
    return localId ? this.all(kind).find((entry) => entry.localId === localId) : undefined;
  }

  private state(entry: Entry): ItemState {
    return (entry.sections.state?.value as ItemState | undefined) ?? "off";
  }

  /** Local ids of the skills synced agents carry here. */
  private carried(): Map<string, string[]> {
    const out = new Map<string, string[]>();
    for (const entry of this.all("agent")) {
      if (this.state(entry) !== "on" || !entry.localId) continue;
      let skills: string[];
      let name: string;
      try {
        const agent = this.host.getAgent(entry.localId);
        skills = agent?.skills ?? [];
        name = agent?.name ?? entry.localId;
      } catch {
        // Can't be read just now: the skills it last synced with are still the ones it carries.
        skills = ((entry.sections.skills?.value as string[] | undefined) ?? []).map((syncId) => this.entries.get(syncId)?.localId ?? "").filter(Boolean);
        name = String(entry.sections.name?.value ?? entry.localId);
      }
      for (const skill of skills) out.set(skill, [...(out.get(skill) ?? []), name]);
    }
    return out;
  }

  /** Says once per look that an item was left alone because it couldn't be read. */
  private leftAlone(entry: Entry, error: unknown): void {
    this.host.log(`Sync: left ${entry.kind} ${entry.localId} alone this time: ${error instanceof Error ? error.message : String(error)}`);
  }

  private syncing(entry: Entry, carried = this.carried()): boolean {
    const state = this.state(entry);
    if (state === "deleted") return false;
    if (state === "on") return true;
    return entry.kind === "skill" && Boolean(entry.localId) && carried.has(entry.localId);
  }

  // ---------------------------------------------------------------- turning it on and off

  /** Turns syncing an agent or skill on or off here; the other machines follow. */
  setOn(kind: ItemKind, localId: string, on: boolean): void {
    if (!this.me) throw new Error("Sync is not running. Turn it on in Settings.");
    const exists = kind === "agent" ? this.host.getAgent(localId) : this.host.getSkill(localId);
    if (!exists) throw new Error(kind === "agent" ? "That agent no longer exists." : "That skill no longer exists.");
    let entry = this.byLocal(kind, localId);
    if (!entry) {
      if (!on) return;
      entry = { syncId: newSyncId(kind), kind, localId, sections: {}, placeAt: {}, engineUsed: "", from: "", lost: [] };
      this.entries.set(entry.syncId, entry);
    }
    if (this.state(entry) === (on ? "on" : "off")) return;
    this.localChange(entry, "state", on ? "on" : "off");
    this.save(entry);
    this.scan();
  }

  private stamp(): Stamp {
    return { at: this.now().toISOString(), by: this.me };
  }

  private localChange(entry: Entry, name: SectionName, value: unknown): void {
    const was = entry.sections[name];
    const base = was?.base ?? emptyOf(TYPE[name]);
    entry.sections[name] = { value, v: tick(was?.v ?? {}, this.me), ...this.stamp(), hash: hashValue(value), base };
  }

  // ---------------------------------------------------------------- this machine's side

  private context!: PlaceContext;

  /** Where things are on this machine, for folders. Set before each pass. */
  setPlaces(context: PlaceContext): void {
    this.context = context;
  }

  private engineRow(id: string): PortableEngine {
    const row = this.host.engines().find((engine) => engine.id === id);
    return row ? { id: row.id, label: row.label, bin: path.basename(row.bin) } : { id, label: id, bin: "" };
  }

  /** The skill's sync id, made when a synced agent carries a skill that doesn't sync yet. */
  private skillSyncId(localId: string): string {
    const found = this.byLocal("skill", localId);
    if (found) return found.syncId;
    const entry: Entry = { syncId: newSyncId("skill"), kind: "skill", localId, sections: {}, placeAt: {}, engineUsed: "", from: "", lost: [] };
    // Off by itself: it syncs because an agent carries it.
    entry.sections.state = { value: "off", v: {}, ...this.stamp(), hash: hashValue("off"), base: null };
    this.entries.set(entry.syncId, entry);
    this.save(entry);
    return entry.syncId;
  }

  /** One part of an item as it is on this machine now. */
  private read(entry: Entry, name: SectionName): unknown {
    if (name === "state") return this.state(entry);
    if (entry.kind === "skill") {
      const skill = this.host.getSkill(entry.localId);
      if (!skill) return undefined;
      return name === "name" ? skill.name : name === "description" ? skill.description : skill.body;
    }
    const agent = this.host.getAgent(entry.localId);
    if (!agent) return undefined;
    switch (name) {
      case "name":
        return agent.name;
      case "brief":
        return agent.brief;
      case "memory":
        return this.host.readMemory(agent.id);
      case "goodAt":
        return agent.goodAt;
      case "tier":
        return agent.tier;
      case "allowRoutines":
        return agent.allowRoutines;
      case "engine": {
        const kept = entry.sections.engine?.value as PortableEngine | undefined;
        // Still the stand-in this machine picked: it asks for what it asked for.
        if (kept && entry.engineUsed && agent.engine === entry.engineUsed) return kept;
        return this.engineRow(agent.engine);
      }
      case "skills": {
        const mine = agent.skills.filter((id) => this.host.getSkill(id)).map((id) => this.skillSyncId(id));
        const kept = (entry.sections.skills?.value as string[] | undefined) ?? [];
        // Skills that haven't arrived here yet are still the agent's.
        const waiting = kept.filter((syncId) => !this.entries.get(syncId)?.localId);
        return sorted(name, [...new Set([...mine, ...waiting])]);
      }
      case "places": {
        const kept = (entry.sections.places?.value as PortablePlace[] | undefined) ?? [];
        const out: PortablePlace[] = [];
        for (const folder of agent.places) {
          const key = Object.entries(entry.placeAt).find(([, at]) => at === folder)?.[0];
          const known = key ? kept.find((place) => place.key === key) : undefined;
          const place = known ?? portablePlace(folder, this.context);
          if (!place || out.some((item) => item.key === place.key)) continue;
          entry.placeAt[place.key] = folder;
          out.push(place);
        }
        // Folders that aren't on this machine yet stay the agent's; one a person removed here doesn't.
        for (const place of kept) if (!entry.placeAt[place.key] && !out.some((item) => item.key === place.key)) out.push(place);
        for (const key of Object.keys(entry.placeAt)) if (!out.some((place) => place.key === key)) delete entry.placeAt[key];
        return sorted(name, out);
      }
    }
    return undefined;
  }

  /**
   * Looks at every synced item here for changes (by VibeForge, a CLI or a hand edit) and notes them
   * as this machine's. Items deleted here are told as deleted once Undo is over. True when anything
   * changed that the other machines should hear; `recheck` when a delete is still waiting.
   */
  scan(): { changed: boolean; recheck: boolean } {
    if (!this.me || !this.context) return { changed: false, recheck: false };
    const result = this.readPass();
    this.project();
    return result;
  }

  /** The part of a look that only notes this machine's own changes. */
  private readPass(): { changed: boolean; recheck: boolean } {
    let changed = false;
    let recheck = false;
    // Skills a synced agent carries get their sync id first, so they go out with it.
    for (const entry of this.all("agent")) {
      if (this.state(entry) !== "on" || !entry.localId) continue;
      try {
        this.read(entry, "skills");
      } catch {
        /* can't be read just now: said below, where it is left alone */
      }
    }
    const carried = this.carried();
    for (const entry of this.all()) {
      let dirty = false;
      let gone: boolean;
      try {
        gone = Boolean(entry.localId) && !this.exists(entry);
      } catch (error) {
        // There but unreadable: neither deleted nor changed, as far as this machine can tell.
        this.leftAlone(entry, error);
        continue;
      }
      if (gone) {
        const since = this.missingSince.get(entry.syncId) ?? this.now().getTime();
        this.missingSince.set(entry.syncId, since);
        if (this.now().getTime() - since < DELETE_GRACE_MS) {
          recheck = true;
          continue;
        }
        this.missingSince.delete(entry.syncId);
        entry.localId = "";
        if (this.syncing(entry, carried)) {
          this.localChange(entry, "state", "deleted");
          dirty = true;
        }
      } else this.missingSince.delete(entry.syncId);
      if (entry.localId && this.syncing(entry, carried)) {
        // Every part read before any is noted, so one that can't be read leaves the item as it was.
        let parts: Array<[SectionName, unknown]>;
        try {
          parts = sectionsOf(entry.kind)
            .filter((name) => name !== "state")
            .map((name) => [name, this.read(entry, name)]);
        } catch (error) {
          this.leftAlone(entry, error);
          continue;
        }
        for (const [name, value] of parts) {
          if (value === undefined) continue;
          if (entry.sections[name]?.hash === hashValue(value)) continue;
          this.localChange(entry, name, value);
          dirty = true;
        }
      }
      if (dirty) {
        this.save(entry);
        changed = true;
      }
    }
    return { changed, recheck };
  }

  private exists(entry: Entry): boolean {
    return Boolean(entry.kind === "agent" ? this.host.getAgent(entry.localId) : this.host.getSkill(entry.localId));
  }

  /**
   * Brings this machine's copies in line with what is kept: folders found since, skills arrived
   * since, the CLI it asks for installed since. Changes nothing the other machines are told.
   */
  private project(): void {
    const touched = new Set<ItemKind>();
    for (const entry of this.all("agent")) {
      if (!entry.localId || this.state(entry) !== "on") continue;
      let agent: Agent | null;
      let next: Agent;
      try {
        agent = this.host.getAgent(entry.localId);
        if (!agent) continue;
        next = this.localAgent(entry, agent);
      } catch (error) {
        this.leftAlone(entry, error);
        continue;
      }
      if (JSON.stringify(next) !== JSON.stringify(agent)) {
        this.host.saveAgent(next);
        this.save(entry);
        touched.add("agent");
      }
    }
    if (touched.size) this.host.changed([...touched]);
  }

  /** The agent as it should be here, from what is kept: only the parts that depend on this machine. */
  private localAgent(entry: Entry, agent: Agent): Agent {
    const next = { ...agent };
    const engine = entry.sections.engine?.value as PortableEngine | undefined;
    if (engine) {
      const used = pickEngine(engine, this.host.engines(), this.host.defaultEngine());
      next.engine = used;
      entry.engineUsed = used;
    }
    const skills = entry.sections.skills?.value as string[] | undefined;
    if (skills) {
      const local = skills.map((syncId) => this.entries.get(syncId)?.localId ?? "").filter((id) => id && this.host.getSkill(id));
      // Skills this machine's agent carries that don't sync (yet) stay until the next look.
      next.skills = [...new Set([...local, ...agent.skills.filter((id) => !this.byLocal("skill", id))])];
    }
    const places = entry.sections.places?.value as PortablePlace[] | undefined;
    if (places) {
      const found: string[] = [];
      for (const place of places) {
        const at = entry.placeAt[place.key];
        const folder = at && fs.existsSync(at) ? at : resolvePlace(place, this.context);
        if (!folder) continue;
        entry.placeAt[place.key] = folder;
        if (!found.includes(folder)) found.push(folder);
      }
      // Folders only this machine can name (outside every workspace and home) stay here.
      const own = agent.places.filter((folder) => !Object.values(entry.placeAt).includes(folder) && !portablePlace(folder, this.context));
      next.places = [...found, ...own.filter((folder) => !found.includes(folder))];
    }
    return next;
  }

  // ---------------------------------------------------------------- telling the other machines

  private record(entry: Entry): LibraryRecord {
    const sections: LibraryRecord["sections"] = {};
    for (const [name, section] of Object.entries(entry.sections) as Array<[SectionName, Section]>) sections[name] = { value: section.value, v: section.v, at: section.at, by: section.by };
    return { v: 1, kind: entry.kind, syncId: entry.syncId, sections, lost: entry.lost };
  }

  /** Writes this machine's file for each item it has a say in, into each paired machine's folder. */
  publish(myId: string, peers: readonly Peer[]): void {
    const carried = this.carried();
    for (const peer of peers) {
      const dir = path.join(peer.dir, "library", myId);
      for (const entry of this.all()) {
        // A skill that only synced while an agent carried it, and was never turned on, has nothing more to say.
        if (!this.syncing(entry, carried) && !Object.keys(entry.sections.state?.v ?? {}).length) continue;
        const file = path.join(dir, `${entry.syncId}.json`);
        const next = `${JSON.stringify(this.record(entry), null, 2)}\n`;
        try {
          if (fs.existsSync(file) && fs.readFileSync(file, "utf8") === next) continue;
          fs.mkdirSync(dir, { recursive: true });
          writeFileAtomic(file, next, { mode: 0o600 });
        } catch (error) {
          this.host.log(`Sync: could not write ${entry.syncId} for ${peer.name}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
  }

  // ---------------------------------------------------------------- hearing from them

  /**
   * Reads what each paired machine says about each item and merges it in. Items new here are made
   * (or joined with a same-named one that is the same), items deleted there go to the trash here
   * unless they changed here since. True when anything changed that the other machines should hear.
   */
  async receive(peers: readonly Peer[]): Promise<boolean> {
    if (!this.me || !this.context) return false;
    this.load();
    // This machine's own changes since the last look are noted first, so they merge instead of being written over.
    let changed = this.readPass().changed;
    const all: Array<{ peer: Peer; record: LibraryRecord }> = [];
    for (const peer of peers) {
      const dir = path.join(peer.dir, "library", peer.id);
      let names: string[] = [];
      try {
        names = fs.readdirSync(dir).filter((name) => name.endsWith(".json")).slice(0, 5000);
      } catch {
        continue;
      }
      for (const name of names) {
        const record = readRecord(path.join(dir, name));
        if (record && `${record.syncId}.json` === name) all.push({ peer, record });
      }
    }
    // The skills an agent turned on carries, there or here: made here even while they aren't on by themselves.
    const wanted = new Set(all.flatMap(({ record }) => (record.kind === "agent" && record.sections.state?.value === "on" ? ((record.sections.skills?.value as string[] | undefined) ?? []) : [])));
    for (const entry of this.all("agent")) if (this.state(entry) === "on") for (const id of (entry.sections.skills?.value as string[] | undefined) ?? []) wanted.add(id);
    // Unchanged since last merged, and already here: nothing to do. Skills first, so an agent arriving with them finds them.
    const fresh = all
      .filter(({ peer, record }) => this.seen.get(`${peer.id}/${record.syncId}`) !== hashValue(record) || !this.entries.has(record.syncId))
      .sort((a, b) => (a.record.kind === b.record.kind ? 0 : a.record.kind === "skill" ? -1 : 1));
    const touched = new Set<ItemKind>();
    for (const { peer, record } of fresh) {
      try {
        const result = await this.take(peer, record, wanted);
        changed ||= result.changed;
        if (result.touched) touched.add(record.kind);
        this.seen.set(`${peer.id}/${record.syncId}`, hashValue(record));
      } catch (error) {
        this.host.log(`Sync: could not take ${record.kind} ${record.syncId} from ${peer.name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    this.project();
    if (touched.size) this.host.changed([...touched]);
    return changed;
  }

  private async take(peer: Peer, record: LibraryRecord, wanted: Set<string>): Promise<{ changed: boolean; touched: boolean }> {
    this.load();
    let entry = this.entries.get(record.syncId);
    const theirState = record.sections.state?.value as ItemState;
    if (!entry) {
      // Something this machine never had: only an agent turned on, or a skill one carries, is made here.
      if (theirState === "deleted" || (theirState === "off" && !wanted.has(record.syncId))) return { changed: false, touched: false };
      entry = this.adopt(record) ?? { syncId: record.syncId, kind: record.kind, localId: "", sections: {}, placeAt: {}, engineUsed: "", from: peer.name, lost: [] };
      this.entries.set(entry.syncId, entry);
    }
    const before = JSON.stringify(entry.sections);
    const hadLocal = Boolean(entry.localId);
    // Changes here the other machine hadn't seen when it said what it says now.
    const unseen = sectionsOf(record.kind).some((name) => {
      const mine = entry.sections[name];
      if (name === "state" || !mine?.v[this.me]) return false;
      const order = compareClocks(mine.v, record.sections[name]?.v ?? {});
      return order === "after" || order === "apart";
    });
    const replaced: Array<{ name: SectionName; text: string }> = [];
    for (const name of sectionsOf(record.kind)) {
      const theirs = record.sections[name];
      if (theirs) this.mergeSection(entry, name, theirs, record.lost, replaced);
    }
    entry.lost = entry.lost.slice(-50);
    // A delete loses to a change it never saw: the item stays here, on, and the other machines get it back.
    if (this.state(entry) === "deleted" && unseen && entry.localId && this.exists(entry)) {
      const state = entry.sections.state as Section & { hash: string; base: unknown };
      entry.sections.state = { value: "on", v: tick(state.v, this.me), ...this.stamp(), hash: hashValue("on"), base: "on" };
    }
    const state = this.state(entry);
    let touched = false;
    if (state === "deleted") {
      if (entry.localId && this.exists(entry)) {
        await this.host.remove(entry.kind, entry.localId);
        touched = true;
      }
      entry.localId = "";
    } else if (state === "on" || (entry.kind === "skill" && (wanted.has(entry.syncId) || this.carried().has(entry.localId)))) {
      touched = this.write(entry);
      if (!hadLocal && entry.localId) this.host.arrived(entry.kind, String(entry.sections.name?.value ?? entry.localId), peer.name);
    }
    for (const lost of replaced) {
      this.conflicts.keepText({ kind: entry.kind, syncId: entry.syncId, itemId: entry.localId, name: String(entry.sections.name?.value ?? entry.localId), section: lost.name as "memory" | "brief" | "body" }, lost.text, peer.id.slice(0, 7));
    }
    this.save(entry);
    return { changed: before !== JSON.stringify(entry.sections), touched };
  }

  /**
   * An item new here that may already be here under its own id: an agent with the same name and
   * brief, or a skill with the same name and text, that doesn't sync yet. Its parts count as this
   * machine's own changes, so they merge with the other machine's (memories are joined) instead of
   * being replaced.
   */
  private adopt(record: LibraryRecord): Entry | null {
    const name = String(record.sections.name?.value ?? "").trim().toLowerCase();
    if (!name) return null;
    const unsynced = (kind: ItemKind, id: string) => !this.byLocal(kind, id);
    let localId = "";
    if (record.kind === "agent") {
      const brief = String(record.sections.brief?.value ?? "").trim();
      localId = this.host.agents().find((agent) => unsynced("agent", agent.id) && agent.name.trim().toLowerCase() === name && agent.brief.trim() === brief)?.id ?? "";
    } else {
      const body = String(record.sections.body?.value ?? "").trim();
      localId = this.host.skills().find((skill) => unsynced("skill", skill.id) && skill.name.trim().toLowerCase() === name && skill.body.trim() === body)?.id ?? "";
    }
    if (!localId) return null;
    const entry: Entry = { syncId: record.syncId, kind: record.kind, localId, sections: {}, placeAt: {}, engineUsed: "", from: "", lost: [] };
    const updated = record.kind === "agent" ? this.host.getAgent(localId)?.updatedAt : "";
    for (const sectionName of sectionsOf(record.kind)) {
      if (sectionName === "state") continue;
      const value = this.read(entry, sectionName);
      if (value === undefined) continue;
      entry.sections[sectionName] = { value, v: { [this.me]: 1 }, at: updated || "", by: this.me, hash: hashValue(value), base: emptyOf(TYPE[sectionName]) };
    }
    return entry;
  }

  /** Merges one part of another machine's version into this one's. */
  private mergeSection(entry: Entry, name: SectionName, theirs: Section, notes: readonly LostNote[], replaced: Array<{ name: SectionName; text: string }>): void {
    const mine = entry.sections[name];
    const take = (value: unknown, v: Clock, stamp: Stamp) => {
      entry.sections[name] = { value, v, at: stamp.at, by: stamp.by, hash: hashValue(value), base: value };
    };
    if (!mine) {
      take(theirs.value, theirs.v, theirs);
      return;
    }
    const theirHash = hashValue(theirs.value);
    switch (compareClocks(theirs.v, mine.v)) {
      case "before":
        return;
      case "same":
        // The same changes counted, yet different values (both merged at once, differently): one rule picks the same one on both.
        if (theirHash !== mine.hash && (later(theirs, mine) || (theirs.at === mine.at && theirs.by === mine.by && theirHash > mine.hash))) take(theirs.value, theirs.v, theirs);
        return;
      case "after": {
        // The other machine has seen this one's version. If its merge replaced this machine's text, keep that text here.
        const lostHere = notes.some((note) => note.section === name && note.by === this.me && note.hash === mine.hash);
        if (lostHere && mine.hash !== theirHash && typeof mine.value === "string" && TYPE[name] !== "value") replaced.push({ name, text: mine.value });
        take(theirs.value, theirs.v, theirs);
        return;
      }
      case "apart":
        break;
    }
    // Both changed it since they last agreed.
    const type = TYPE[name];
    let value: unknown;
    if (type === "text" || type === "memory") {
      const merged = mergeText(String(mine.base ?? ""), { text: String(mine.value ?? ""), at: mine.at, by: mine.by }, { text: String(theirs.value ?? ""), at: theirs.at, by: theirs.by }, type === "memory" ? "union" : "later");
      value = merged.text;
      if (merged.oursLost || (type === "memory" && merged.clashed)) replaced.push({ name, text: String(mine.value ?? "") });
      if (merged.theirsLost) entry.lost.push({ section: name, by: theirs.by, hash: theirHash });
    } else if (type === "set") {
      value = sorted(name, mergeSet((mine.base as unknown[] | undefined) ?? [], { items: (mine.value as unknown[]) ?? [], at: mine.at, by: mine.by }, { items: (theirs.value as unknown[]) ?? [], at: theirs.at, by: theirs.by }, keyOf(name)));
    } else value = later(mine, theirs) ? mine.value : theirs.value;
    const v = joinClocks(mine.v, theirs.v);
    if (hashValue(value) === theirHash) take(value, v, theirs);
    else {
      entry.sections[name] = { value, v: tick(v, this.me), ...this.stamp(), hash: hashValue(value), base: value };
    }
  }

  /** Makes this machine's copy match what is kept. True when it wrote anything. */
  private write(entry: Entry): boolean {
    const get = <T>(name: SectionName, fallback: T): T => (entry.sections[name]?.value as T | undefined) ?? fallback;
    if (entry.kind === "skill") {
      const current = entry.localId ? this.host.getSkill(entry.localId) : null;
      const name = get("name", current?.name ?? "Skill");
      const skill: Skill = { id: current?.id ?? this.host.newId("skill", name), name, description: get("description", current?.description ?? ""), body: get("body", current?.body ?? "") };
      if (current && JSON.stringify(current) === JSON.stringify(skill)) return false;
      this.host.saveSkill(skill);
      entry.localId = skill.id;
      return true;
    }
    const current = entry.localId ? this.host.getAgent(entry.localId) : null;
    const name = get("name", current?.name ?? "Agent");
    const stamp = this.now().toISOString();
    const base: Agent = current ?? {
      id: this.host.newId("agent", name),
      name,
      engine: "",
      brief: "",
      memoryFile: "memory.md",
      places: [],
      skills: [],
      allowRoutines: true,
      goodAt: "",
      tier: "",
      createdAt: stamp,
      updatedAt: stamp,
    };
    const shaped = this.localAgent(entry, {
      ...base,
      name,
      brief: get("brief", base.brief),
      goodAt: get("goodAt", base.goodAt),
      tier: get<AgentTier>("tier", base.tier),
      allowRoutines: get("allowRoutines", base.allowRoutines),
    });
    const memory = get<string | null>("memory", null);
    const sameAgent = current && JSON.stringify({ ...current, updatedAt: "" }) === JSON.stringify({ ...shaped, updatedAt: "" });
    const sameMemory = memory === null || (current && this.host.readMemory(current.id) === memory);
    if (sameAgent && sameMemory) return false;
    if (!sameAgent) this.host.saveAgent({ ...shaped, updatedAt: stamp });
    entry.localId = shaped.id;
    if (memory !== null && !sameMemory) this.host.writeMemory(shaped.id, memory);
    // Whatever reads back differently (saved a little differently) goes out at the next look as this machine's change.
    return true;
  }

  // ---------------------------------------------------------------- answering a conflict

  /** Puts this machine's saved text back. It then goes to the other machines as a change here. */
  restore(record: ConflictRecord, text: string): void {
    const entry = this.entries.get(record.folderId) ?? (this.load(), this.entries.get(record.folderId));
    const localId = entry?.localId || record.itemId || "";
    if (record.kind === "agent") {
      const agent = this.host.getAgent(localId);
      if (!agent) throw new Error("That agent no longer exists.");
      if (record.section === "memory") this.host.writeMemory(agent.id, text);
      else this.host.saveAgent({ ...agent, brief: text, updatedAt: this.now().toISOString() });
      this.host.changed(["agent"]);
    } else {
      const skill = this.host.getSkill(localId);
      if (!skill) throw new Error("That skill no longer exists.");
      this.host.saveSkill({ ...skill, body: text });
      this.host.changed(["skill"]);
    }
  }

  /** The text an agent or skill conflict is about, as it is now. */
  current(record: ConflictRecord): string {
    const entry = this.entries.get(record.folderId) ?? (this.load(), this.entries.get(record.folderId));
    const localId = entry?.localId || record.itemId || "";
    if (record.kind === "agent") return record.section === "memory" ? this.host.readMemory(localId) : (this.host.getAgent(localId)?.brief ?? "");
    return this.host.getSkill(localId)?.body ?? "";
  }

  // ---------------------------------------------------------------- a folder picked by hand

  /** Uses `folder` here for an agent's place that wasn't found on this machine. */
  placeAt(agentId: string, key: string, folder: string): void {
    const entry = this.byLocal("agent", agentId);
    const places = (entry?.sections.places?.value as PortablePlace[] | undefined) ?? [];
    if (!entry || !places.some((place) => place.key === key)) throw new Error("That folder is no longer waiting.");
    entry.placeAt[key] = path.resolve(folder);
    const agent = this.host.getAgent(agentId);
    if (agent) {
      this.host.saveAgent(this.localAgent(entry, agent));
      this.host.changed(["agent"]);
    }
    this.save(entry);
  }

  // ---------------------------------------------------------------- for the window

  view(): LibraryView {
    const carried = this.carried();
    const out: LibraryView = { agents: {}, skills: {} };
    for (const entry of this.all()) {
      if (!entry.localId) continue;
      const item: LibraryItemView = { on: this.state(entry) === "on", syncing: this.syncing(entry, carried), via: [], from: entry.from, waiting: [], engine: null };
      if (entry.kind === "skill") {
        item.via = carried.get(entry.localId) ?? [];
        out.skills[entry.localId] = item;
        continue;
      }
      if (item.on) {
        let agent: Agent | null = null;
        try {
          agent = this.host.getAgent(entry.localId);
        } catch {
          // Can't be read just now: the Agents view says so; nothing here to point at.
          out.agents[entry.localId] = item;
          continue;
        }
        for (const place of (entry.sections.places?.value as PortablePlace[] | undefined) ?? []) {
          const at = entry.placeAt[place.key];
          if (!at || !agent?.places.includes(at)) item.waiting.push({ key: place.key, label: placeLabel(place), folderId: place.folderId });
        }
        const wanted = entry.sections.engine?.value as PortableEngine | undefined;
        if (wanted && agent && agent.engine !== wanted.id && agent.engine === entry.engineUsed) item.engine = { wanted: wanted.label, using: this.engineRow(agent.engine).label };
      }
      out.agents[entry.localId] = item;
    }
    return out;
  }
}
