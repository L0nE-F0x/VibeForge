import type { Agent } from "../../shared/api.js";

/** The coding CLIs in a folder, by name: the agent's when there is one, else the CLI's. */
export function writerNames(writers: ReadonlyArray<{ label: string; agentId: string | null }>, agents: readonly Agent[]): string {
  const names = writers.map((writer) => agents.find((agent) => agent.id === writer.agentId)?.name ?? writer.label);
  return [...new Set(names)].join(", ");
}
