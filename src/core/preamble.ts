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
