// A finished run as Markdown, for an issue or a pull request: what it was asked, how it ended and
// what it changed. Pure; the run service reads the run's files. Like a Hand off packet, it is in
// English and quotes the end of the transcript, not all of it.

import type { RunMeta } from "./types.js";

/** How much of the end of the transcript is quoted. */
export const MARKDOWN_TAIL = 6_000;
/** The longest patch quoted in full; a longer one is cut at a file boundary where it can be. */
export const MARKDOWN_PATCH = 40_000;

export interface RunMarkdownInput {
  run: Pick<RunMeta, "id" | "title" | "engine" | "cwd" | "prompt" | "startedAt" | "endedAt" | "status" | "exitCode" | "changes" | "error">;
  engineLabel: string | null;
  agentName: string | null;
  /** What was typed, for a CLI started by hand (its run has no prompt of its own). */
  typedPrompts: string;
  transcript: string;
  /** The patch frozen when the run ended, or "" when there is none. */
  patch: string;
  /** `git status` and `git diff --stat` at the end, for a run with no saved patch. */
  gitSummary: string;
  home: string;
}

export function runMarkdown(input: RunMarkdownInput): string {
  const { run } = input;
  const cli = input.engineLabel ? `${input.engineLabel} (\`${run.engine}\`)` : `\`${run.engine}\``;
  const facts = [
    `- **CLI:** ${cli}${input.agentName ? ` · **Agent:** ${input.agentName}` : ""}`,
    `- **Folder:** \`${tildify(run.cwd, input.home)}\``,
    `- **Started:** ${stamp(run.startedAt)}${run.endedAt ? ` · **Took:** ${took(run.startedAt, run.endedAt)}` : ""}`,
    `- **Result:** ${result(run)}`,
  ];
  if (run.changes) facts.push(`- **Changes:** ${run.changes}`);
  const parts = [`## ${run.title}`, "", ...facts];

  const prompt = (run.prompt.trim() && run.prompt.trim() !== "{prompt}" ? run.prompt : input.typedPrompts).trim();
  if (prompt) parts.push("", "### Prompt", "", fence(prompt, "text"));

  const tail = cleanTail(input.transcript, MARKDOWN_TAIL);
  if (tail) parts.push("", "### How it ended", "", fence(tail, "text"));

  if (input.patch.trim()) {
    const { text, cut } = clipPatch(input.patch, MARKDOWN_PATCH);
    parts.push("", "### Changes", "", fence(text, "diff"));
    if (cut) parts.push("", `_The patch is cut here: ${cut} more file${cut === 1 ? "" : "s"} changed. The full patch is in the run's record in VibeForge._`);
  } else if (input.gitSummary.trim()) {
    parts.push("", "### Changes", "", fence(input.gitSummary.trim(), "text"));
  }

  parts.push("", `<sub>Run \`${run.id}\`, copied from VibeForge.</sub>`);
  return `${parts.join("\n")}\n`;
}

/** A code block that nothing inside it can close: its fence is longer than any run of backticks in the text. */
export function fence(text: string, lang: string): string {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((match) => match[0].length));
  const marks = "`".repeat(Math.max(3, longest + 1));
  return `${marks}${lang}\n${text}\n${marks}`;
}

function result(run: RunMarkdownInput["run"]): string {
  if (run.status === "running") return "still running";
  if (run.status === "stopped") return "stopped";
  if (run.status === "failed") return run.error ? `failed: ${run.error}` : "failed";
  return run.exitCode === 0 || run.exitCode === null ? "finished" : `exited with code ${run.exitCode}`;
}

function stamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function took(from: string, to: string): string {
  const seconds = Math.max(0, Math.round((Date.parse(to) - Date.parse(from)) / 1000));
  if (Number.isNaN(seconds)) return "?";
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.round(seconds / 60);
  return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

function tildify(folder: string, home: string): string {
  if (!home) return folder;
  if (folder === home) return "~";
  return folder.startsWith(`${home}/`) ? `~${folder.slice(home.length)}` : folder;
}

/** The end of a transcript as plain text: no terminal escapes or control characters. */
function cleanTail(text: string, max: number): string {
  const clean = text
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, "")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return clean.length <= max ? clean : `…${clean.slice(-(max - 1))}`;
}

/** The patch up to `max` characters, ending after a whole file, and how many files were left out. */
function clipPatch(patch: string, max: number): { text: string; cut: number } {
  const text = patch.trimEnd();
  if (text.length <= max) return { text, cut: 0 };
  const starts = [...text.matchAll(/^diff --git /gm)].map((match) => match.index);
  const kept = starts.filter((index) => index > 0 && index <= max).pop();
  const end = kept ?? max;
  return { text: text.slice(0, end).trimEnd(), cut: Math.max(1, starts.filter((index) => index >= end).length) };
}
