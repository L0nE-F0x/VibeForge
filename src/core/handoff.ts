// Hand off: a finished run becomes a task for another agent, which starts only when you Execute it.
// The task body is the packet: who did what, which files changed, how it ended, and where the full
// record is. Pure; the task service reads the run and saves the task.

/** The longest a packet gets, so the task file stays something a person can read and edit. */
export const HANDOFF_MAX = 8_000;
/** How much of the end of the transcript is quoted: how it went, not how it started. */
export const HANDOFF_TAIL = 4_000;
/** Changed files listed by name before "and N more". */
export const HANDOFF_FILES = 30;

export interface HandoffInput {
  runId: string;
  title: string;
  agentName: string | null;
  engine: string;
  /** The folder Execute will work in; null when the run had no workspace. */
  workspacePath: string | null;
  /** Where the run worked. A task's own copy may be gone once its changes were applied. */
  sourceCwd: string;
  /** The run's one-line summary of its changes ("2 files changed, …"). */
  changes: string | null;
  files: string[];
  transcript: string;
  transcriptPath: string | null;
  patchPath: string | null;
}

export function handoffTitle(title: string): string {
  const clipped = title.length > 70 ? `${title.slice(0, 69).trimEnd()}…` : title;
  return `Hand off: ${clipped}`;
}

export function handoffBody(input: HandoffInput): string {
  const who = input.agentName ? `${input.agentName} (${input.engine})` : input.engine;
  const lines = [
    `Another agent's run is handed to you. Pick up where it left off: check what it changed, finish what it didn't, and say what you did.`,
    "",
    `Run: ${input.runId}`,
    `By: ${who}`,
    `Task it worked on: ${input.title}`,
    input.workspacePath ? `Work in: ${input.workspacePath}` : "Work in: no workspace yet. Pick one for this task before you Execute it.",
  ];
  if (input.sourceCwd && input.sourceCwd !== input.workspacePath) {
    lines.push(`It worked in: ${input.sourceCwd} (if that was a separate copy, it may be gone once its changes were applied).`);
  }
  if (input.changes) lines.push(`Changes: ${input.changes}`);
  if (input.files.length) {
    const named = input.files.slice(0, HANDOFF_FILES).map((file) => `- ${file}`);
    if (input.files.length > HANDOFF_FILES) named.push(`- and ${input.files.length - HANDOFF_FILES} more`);
    lines.push("", "Files it changed:", ...named);
  }
  const record = [input.transcriptPath && `- Transcript: ${input.transcriptPath}`, input.patchPath && `- Its changes as a patch: ${input.patchPath}`].filter(Boolean) as string[];
  if (record.length) lines.push("", "The full record:", ...record);
  const head = lines.join("\n");
  const room = Math.max(0, HANDOFF_MAX - head.length - 40);
  const tail = cleanTail(input.transcript, Math.min(HANDOFF_TAIL, room));
  return tail ? `${head}\n\nHow it ended:\n\n\`\`\`\n${tail}\n\`\`\`\n` : `${head}\n`;
}

/** The end of a transcript, without control characters or backtick fences that would close the block. */
function cleanTail(text: string, max: number): string {
  if (max <= 0) return "";
  const clean = text
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, "")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "")
    .replace(/```/g, "'''")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return clean.length <= max ? clean : `…${clean.slice(-(max - 1))}`;
}
