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
