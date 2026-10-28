import type { AgentTier } from "./types.js";

export interface PreambleSkill {
  name: string;
  body: string;
}

export interface PreambleInput {
  agentName: string;
  places: readonly string[];
  brief: string;
  memory: string;
  skills: readonly PreambleSkill[];
  prompt: string;
  /** A previous attempt's transcript, for engines that cannot reopen their own session. */
  priorTranscript?: string | null;
  /** The run works in a separate git worktree (`path`) of the workspace (`of`). */
  workingCopy?: { path: string; of: string } | null;
  /** Other CLIs can be reached with `vibeforge tell` and `vibeforge task` (Settings → Agents together). */
  talk?: boolean;
}

/** How a CLI in VibeForge reaches the others; the same words in an agent's preamble and a Code pane's note. */
export const TEAM_COMMANDS =
  "The `vibeforge` command in your shell reaches them: `vibeforge who` lists the CLIs open now and the agents you can hand work to. `vibeforge tell <name> \"…\"` sends one a message (add `--wait` to get its answer back). `vibeforge task <agent> \"…\"` hands an agent a separate piece of work: it works in its own git copy of the workspace, and what it did comes back to you as a message when it finishes (a person applies its changes). Use them when a second opinion or work in parallel helps; keep messages short.";

/** What a coding CLI started in a Code pane is told about the others, where it takes extra instructions (see `instructionArgs`). */
export function codePaneNote(): string {
  return `You are running in a terminal in VibeForge, where other coding CLIs may be open beside you. ${TEAM_COMMANDS}`;
}

/** An agent a lead can hand work to, as its note lists it. */
export interface TeamMember {
  id: string;
  name: string;
  /** Its engine's label: "Grok Build". */
  engine: string;
  goodAt: string;
  tier: AgentTier;
}

const TIER_TEXT: Record<AgentTier, string> = { fast: "Cheap and fast.", everyday: "Everyday cost.", strong: "Strong and costly.", "": "" };

/**
 * What the lead is told when a Code pane starts it: its team in this workspace, how to hand work
 * out, and how far it may go on its own (Settings → Agents together).
 */
export function leadNote(input: { team: readonly TeamMember[]; handOff: "ask" | "go"; maxWorking: number; maxHandOffs: number; leadApplies: boolean }): string {
  const team = input.team.map((member) =>
    [`- ${member.id}: ${member.name === member.id ? "" : `${member.name}, `}${member.engine}.`, member.goodAt ? `Good at: ${member.goodAt.replace(/\.$/, "")}.` : "", TIER_TEXT[member.tier]].filter(Boolean).join(" "),
  );
  return [
    `You are running in a terminal in VibeForge, and you lead in this workspace: the person talks to you, and you can hand parts of the work to other agents. ${TEAM_COMMANDS}`,
    "",
    team.length ? 'Your team here (hand an agent work with `vibeforge task <id> "…"`):' : "No agents may work in this folder yet; a person adds them in VibeForge's Agents view.",
    ...team,
    "",
    "How to lead:",
    "- Do the work yourself unless another agent is better at a part, cheaper for it, or parts can run at the same time. Prefer the cheapest agent that will do a part well, and keep strong ones for the hard parts.",
    "- An agent sees only what you hand it, not this conversation: say what to do, where, and how to tell it's done.",
    "- Each task works in its own git copy and comes back to you as a report when its agent finishes its turn.",
    input.handOff === "ask"
      ? "- Tasks you hand out wait for the person to press Start on your terminal's title bar. Tell them what you handed out and why, and carry on with your own part."
      : `- Tasks you hand out start at once. At most ${input.maxWorking} work at the same time, and you may hand out ${input.maxHandOffs} between two messages from the person; more wait for the person to press Start.`,
    input.leadApplies
      ? "- When a report's changes are right, bring them into this folder with `vibeforge apply <task-id>`, which also ends that task's session. Leave ones you're unsure of for the person."
      : "- The person applies the changes from each task; you can read the patch a report points to.",
  ].join("\n");
}

/** Drop the HTML comment the starter memory file opens with; it is a note to the human. */
export function memoryForPrompt(memory: string): string {
  return memory.replace(/^\s*<!--[\s\S]*?-->\s*/, "").trim();
}

export function buildPreamble(input: PreambleInput): string {
  const copy = input.workingCopy;
  const parts: string[] = [
    "# VibeForge run",
    `Agent: ${input.agentName}`,
    "Allowed folders (work only inside these):",
    ...(copy ? [`- ${copy.path}`] : input.places.map((place) => `- ${place}`)),
    ...(copy
      ? [
          "",
          `This run works in its own git worktree of ${copy.of}, at ${copy.path}. Make every change there, not in ${copy.of}.`,
          "You may commit in it or leave the changes uncommitted; either way they are reviewed and then brought into the workspace.",
        ]
      : []),
    "",
    "## Brief",
    input.brief.trim(),
  ];
  const memory = memoryForPrompt(input.memory);
  if (memory) parts.push("", "## Memory", memory);
  for (const skill of input.skills) {
    if (!skill.body.trim()) continue;
    parts.push("", `## Skill: ${skill.name}`, skill.body.trim());
  }
  if (input.talk) {
    parts.push(
      "",
      "## Other agents",
      `Other coding CLIs may be open in VibeForge beside you. ${TEAM_COMMANDS}`,
    );
  }
  if (input.priorTranscript) {
    parts.push(
      "",
      "## Previous attempt",
      `This continues an earlier attempt. Its transcript is at ${input.priorTranscript}. Read it before you start.`,
    );
  }
  parts.push("", "# This run", input.prompt.trim());
  return `${parts.join("\n")}\n`;
}

export function taskPrompt(title: string, body: string): string {
  const detail = body.trim();
  return detail ? `Task: ${title.trim()}\n\n${detail}` : `Task: ${title.trim()}`;
}

/** Chat and plain Code launches send what the human typed and nothing else. */
export function plainPrompt(prompt: string, priorTranscript?: string | null): string {
  if (!priorTranscript) return prompt.trim();
  return `This continues an earlier session. Its transcript is at ${priorTranscript}.\n\n${prompt.trim()}`;
}
