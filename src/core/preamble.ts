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
  priorTranscript?: string;
}

export function buildPreamble(input: PreambleInput): string {
  void input.priorTranscript;
  const parts: string[] = [
    "# ForgeDesk run",
    `Agent: ${input.agentName}`,
    "Allowed folders:",
    ...input.places.map((place) => `- ${place}`),
    "",
    input.brief.trimEnd(),
  ];
  if (input.memory.trim()) {
    parts.push("", input.memory.trimEnd());
  }
  for (const skill of input.skills) {
    if (!skill.body.trim()) continue;
    parts.push("", skill.body.trimEnd());
  }
  parts.push("", "# This run", input.prompt);
  return parts.join("\n");
}

export function buildStandalonePreamble(prompt: string): string {
  return `# ForgeDesk run\n# This run\n${prompt}`;
}

export function codePreamble(workspacePath: string, prompt: string): string {
  return `# ForgeDesk run\nWorkspace: ${workspacePath}\n\n# This run\n${prompt.trimEnd()}\n`;
}
