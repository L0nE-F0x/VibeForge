import fs from "node:fs";
import path from "node:path";
import { appendMemoryBullet, prepareMemoryLine, removeMemoryLine } from "../../shared/memory.js";
import { dayKey } from "../../shared/text.js";
import { isDirectory } from "../fsx.js";
import { describeError } from "../log.js";
import { agentTier, MEMORY_STARTER, oneLine } from "../store.js";
import type { Agent, Skill } from "../types.js";
import { type AgentInput, type Deleted, normalizePlaces, type RememberResult, type SkillInput } from "./types.js";
import type { ServiceCore } from "./core.js";

/** Agents and skills: the people and the know-how runs are started with. */
export class LibraryDesk {
  constructor(private readonly core: ServiceCore) {}

  listAgents(): Agent[] {
    return this.core.store.listAgents();
  }

  getAgent(id: string): Agent | null {
    return this.core.store.getAgent(id);
  }

  saveAgent(input: AgentInput): Agent {
    const name = input.name?.trim() ?? "";
    if (!name) throw new Error("Give the agent a name.");
    if (!input.brief?.trim()) throw new Error("Write a brief for the agent.");
    const engineId = input.engine?.trim() ?? "";
    if (!engineId) throw new Error("Pick an engine.");
    // One that is there but can't be read says so, rather than "no longer exists".
    const existing = input.id ? this.core.store.readAgent(input.id) : null;
    if (input.id && !existing) throw new Error("That agent no longer exists.");
    if (!existing || existing.engine !== engineId) this.core.requireEngine(engineId);
    const places = normalizePlaces(input.places ?? []);
    // A synced agent can arrive with none of its folders on this machine; it may be saved like that until one is.
    if (places.length === 0 && !(existing && existing.places.length === 0)) throw new Error("Add at least one allowed folder.");
    for (const place of places) {
      if (existing?.places.includes(place)) continue;
      if (!isDirectory(place)) throw new Error(`This folder does not exist: ${place}`);
    }
    const now = this.core.now().toISOString();
    const agent: Agent = {
      id: existing?.id ?? this.core.freeId("agents", name, "", (id) => this.core.store.queryRuns({ agentId: id, limit: 1 }).length > 0),
      name,
      engine: engineId,
      brief: input.brief.trimEnd(),
      memoryFile: "memory.md",
      places,
      skills: input.skills ? input.skills.filter((id) => this.skillKept(id)) : (existing?.skills ?? []),
      allowRoutines: typeof input.allowRoutines === "boolean" ? input.allowRoutines : (existing?.allowRoutines ?? true),
      goodAt: typeof input.goodAt === "string" ? oneLine(input.goodAt) : (existing?.goodAt ?? ""),
      tier: input.tier === undefined ? (existing?.tier ?? "") : agentTier(input.tier),
      createdAt: existing?.createdAt || now,
      updatedAt: now,
    };
    this.core.store.writeAgent(agent);
    this.core.emit("agents", "routines", "tasks");
    return agent;
  }

  /** Whether an agent keeps a skill it is saved with: unless it is gone. One that can't be read is still there. */
  private skillKept(id: string): boolean {
    try {
      return this.core.store.readSkill(id) !== null;
    } catch {
      return true;
    }
  }

  /**
   * Delete an agent, Undo-able: its folder (brief, memory) and its routines go to the trash
   * together, so Undo brings them all back and a new agent given the same name starts without them.
   * Anything running as it is stopped first; that part can't be undone.
   */
  async deleteAgent(id: string): Promise<Deleted> {
    const agent = this.core.store.getAgent(id);
    if (!agent) throw new Error("That agent no longer exists.");
    for (const session of this.core.listLive()) {
      if (session.agentId !== id || !session.runId) continue;
      const exited = this.core.waitForExit(session.ptyId, 6000);
      await this.core.stopRun(session.runId);
      await exited;
    }
    const folder = path.join(this.core.options.configRoot, "agents", agent.id);
    const routines = this.core.store.listRoutines().flatMap((routine) => (routine.agentId === id ? (this.core.store.pathOf("routine", routine.id) ?? []) : []));
    const bin = this.core.trash.stash([folder, ...routines]);
    this.core.emit("agents", "routines", "tasks", "chats");
    return this.core.keepForUndo(bin, (restored) => {
      // A new agent took the name meanwhile, so this one can't come back; nor do its routines, to join that one.
      if (!restored.includes(folder)) for (const file of routines) if (restored.includes(file)) fs.rmSync(file, { force: true });
      this.core.emit("agents", "routines", "tasks", "chats");
    });
  }

  readMemory(agentId: string): string {
    if (!this.core.store.getAgent(agentId)) throw new Error("That agent no longer exists.");
    return this.core.store.readMemory(agentId);
  }

  writeMemory(agentId: string, text: string): void {
    if (!this.core.store.getAgent(agentId)) throw new Error("That agent no longer exists.");
    this.core.store.writeMemory(agentId, text);
    this.core.emit("agents");
  }

  /** Append a dated bullet to the running agent's `memory.md` and register an exact-line Undo. */
  rememberFromPty(input: { fromPty: string | null; text: string }): RememberResult {
    const session = input.fromPty ? this.core.live.get(input.fromPty) : undefined;
    if (!session) return { ok: false, error: "Run this from an agent's terminal in VibeForge; a plain terminal has no agent memory." };
    const run = session.runId ? this.core.store.getRun(session.runId) : null;
    const agentId = run?.agentId ?? session.agentId ?? null;
    if (!agentId) return { ok: false, error: "This terminal isn't running an agent; a plain CLI has no agent memory." };
    const agent = this.core.store.getAgent(agentId);
    if (!agent) return { ok: false, error: "That agent no longer exists." };
    const prepared = prepareMemoryLine(input.text);
    if (!prepared.ok) return prepared;
    let prev: string;
    try {
      prev = this.core.store.readMemory(agent.id);
    } catch (error) {
      return { ok: false, error: describeError(error) };
    }
    const line = `- ${dayKey(this.core.now().toISOString())}: ${prepared.note}`;
    this.core.store.writeMemory(agent.id, appendMemoryBullet(prev, line, MEMORY_STARTER));
    this.core.emit("agents");
    const { undo } = this.core.keepForUndo(this.core.trash.stash([]), () => {
      if (!this.core.store.getAgent(agent.id)) return;
      const current = this.core.store.readMemory(agent.id);
      const updated = removeMemoryLine(current, line);
      if (updated === current) return;
      this.core.store.writeMemory(agent.id, updated);
      this.core.emit("agents");
    });
    const flagged = prepared.flags.length > 0;
    this.core.options.host.remembered?.({ agentId: agent.id, agentName: agent.name, note: prepared.note, line, flagged, undo });
    return { ok: true, agentId: agent.id, agent: agent.name, note: prepared.note, line, flagged, flags: prepared.flags, undo };
  }

  // ---------------------------------------------------------------- skills

  listSkills(): Skill[] {
    return this.core.store.listSkills();
  }

  saveSkill(input: SkillInput): Skill {
    const name = input.name?.trim() ?? "";
    if (!name) throw new Error("Give the skill a name.");
    const existing = input.id ? this.core.store.getSkill(input.id) : null;
    const skill: Skill = {
      id: existing?.id ?? this.core.freeId("skills", name, ""),
      name,
      description: (input.description ?? existing?.description ?? "").trim(),
      body: input.body ?? existing?.body ?? "",
    };
    this.core.store.writeSkill(skill);
    this.core.emit("skills");
    return skill;
  }

  deleteSkill(id: string): Deleted {
    const dir = this.core.store.pathOf("skill", id);
    if (!dir) throw new Error("That skill no longer exists.");
    const agents = this.core.store.listAgents().filter((agent) => agent.skills.includes(id)).map((agent) => agent.id);
    const bin = this.core.trash.stash([dir]);
    this.setSkillAgents(id, []);
    this.core.emit("skills", "agents");
    return this.core.keepForUndo(bin, (restored) => {
      if (!restored.includes(dir)) return;
      this.setSkillAgents(id, agents);
      this.core.emit("skills", "agents");
    });
  }

  setSkillAgents(skillId: string, agentIds: string[]): void {
    const now = this.core.now().toISOString();
    for (const agent of this.core.store.listAgents()) {
      const has = agent.skills.includes(skillId);
      const want = agentIds.includes(agent.id);
      if (has === want) continue;
      const skills = want ? [...agent.skills, skillId] : agent.skills.filter((id) => id !== skillId);
      this.core.store.writeAgent({ ...agent, skills, updatedAt: now });
    }
    this.core.emit("agents", "skills");
  }
}
