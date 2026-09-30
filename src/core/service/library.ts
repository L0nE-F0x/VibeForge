import path from "node:path";
import { isDirectory } from "../fsx.js";
import type { Agent, Skill } from "../types.js";
import { type AgentInput, type Deleted, normalizePlaces, type SkillInput } from "./types.js";
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
    const existing = input.id ? this.core.store.getAgent(input.id) : null;
    if (input.id && !existing) throw new Error("That agent no longer exists.");
    if (!existing || existing.engine !== engineId) this.core.requireEngine(engineId);
    const places = normalizePlaces(input.places ?? []);
    if (places.length === 0) throw new Error("Add at least one allowed folder.");
    for (const place of places) {
      if (existing?.places.includes(place)) continue;
      if (!isDirectory(place)) throw new Error(`This folder does not exist: ${place}`);
    }
    const now = this.core.now().toISOString();
    const agent: Agent = {
      id: existing?.id ?? this.core.store.uniqueId(path.join(this.core.options.configRoot, "agents"), name, ""),
      name,
      engine: engineId,
      brief: input.brief.trimEnd(),
      memoryFile: "memory.md",
      places,
      skills: input.skills ? input.skills.filter((id) => this.core.store.getSkill(id)) : (existing?.skills ?? []),
      allowRoutines: typeof input.allowRoutines === "boolean" ? input.allowRoutines : (existing?.allowRoutines ?? true),
      voice: typeof input.voice === "string" ? input.voice.trim() : (existing?.voice ?? ""),
      createdAt: existing?.createdAt || now,
      updatedAt: now,
    };
    this.core.store.writeAgent(agent);
    this.core.emit("agents", "routines", "tasks");
    return agent;
  }

  deleteAgent(id: string, confirmName: string): void {
    const agent = this.core.store.getAgent(id);
    if (!agent) throw new Error("That agent no longer exists.");
    if (confirmName.trim() !== agent.name) throw new Error("Type the agent's name exactly to delete it.");
    this.core.store.deleteAgent(id);
    this.core.emit("agents", "routines", "tasks", "chats");
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

  // ---------------------------------------------------------------- skills

  listSkills(): Skill[] {
    return this.core.store.listSkills();
  }

  saveSkill(input: SkillInput): Skill {
    const name = input.name?.trim() ?? "";
    if (!name) throw new Error("Give the skill a name.");
    const existing = input.id ? this.core.store.getSkill(input.id) : null;
    const skill: Skill = {
      id: existing?.id ?? this.core.store.uniqueId(path.join(this.core.options.configRoot, "skills"), name, ""),
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
    return this.core.keepForUndo(bin, () => {
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
