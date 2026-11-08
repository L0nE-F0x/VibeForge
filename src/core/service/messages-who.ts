import { Handles, reachable, type Reachable } from "../agent-talk.js";
import { cwdAllowed } from "../places.js";
import type { AgentTier, EngineRow, LiveSession } from "../types.js";
import type { ServiceCore } from "./core.js";

export interface WhoResult {
  you: string | null;
  clis: Array<{ handle: string; label: string; folder: string; working: boolean; you: boolean }>;
  /** The agents `vibeforge task` can hand work to: those allowed in the asking CLI's workspace, or all from outside one. */
  agents: Array<{ name: string; handle: string; engine: string; goodAt: string; tier: AgentTier }>;
}

/** Who is there to talk to: the coding CLIs running in VibeForge, each by a handle that stays its own, and the agents. */
export class Roster {
  private readonly handles = new Handles();

  constructor(private readonly core: ServiceCore) {}

  /** Every coding CLI that can be reached. The engines and each agent are read once for the lot, not once per CLI. */
  list(): Reachable[] {
    const rows = this.core.store.readEngineRows();
    const agents = new Map<string, string | null>();
    return reachable(
      [...this.core.live.values()],
      {
        agent: (id) => {
          if (!agents.has(id)) agents.set(id, this.core.store.getAgent(id)?.name ?? null);
          return agents.get(id) ?? null;
        },
        engine: (session) => this.engineOf(session, rows),
      },
      this.handles,
    );
  }

  engineOf(session: LiveSession, rows: readonly EngineRow[] = this.core.store.readEngineRows()): { id: string; label: string; bin: string } | null {
    const id = session.programEngineId || (session.runId ? this.core.store.getRun(session.runId)?.engine : null) || null;
    if (!id) return null;
    const row = rows.find((item) => item.id === id);
    return { id, label: row?.label ?? id, bin: row?.bin ?? id };
  }

  who(fromPty: string | null): WhoResult {
    const list = this.list();
    return {
      you: list.find((item) => item.ptyId === fromPty)?.handle ?? null,
      clis: list.map((item) => ({ handle: item.handle, label: item.label, folder: item.cwd, working: item.working, you: item.ptyId === fromPty })),
      agents: this.teamFor(fromPty),
    };
  }

  private teamFor(fromPty: string | null): WhoResult["agents"] {
    const session = fromPty ? this.core.live.get(fromPty) : undefined;
    const folder = this.core.workspaceById(session?.workspaceId)?.path ?? null;
    const rows = this.core.store.readEngineRows();
    return (
      this.core.store
        .listAgents()
        .filter((agent) => !folder || cwdAllowed(folder, agent.places))
        // An agent's id is the name `vibeforge task` takes; a cut of the name could be another agent's.
        .map((agent) => ({ name: agent.name, handle: agent.id, engine: rows.find((row) => row.id === agent.engine)?.label ?? agent.engine, goodAt: agent.goodAt, tier: agent.tier }))
    );
  }
}
