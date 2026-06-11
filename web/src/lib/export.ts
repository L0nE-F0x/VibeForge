import type { Project } from "@vibeforge/shared";

/** The spec as a standalone Markdown document. */
export function specMarkdown(p: Project): string {
  const date = new Date().toISOString().slice(0, 10);
  return [
    p.spec.trim(),
    "",
    "---",
    `*Build spec for **${p.title}** — generated with [Vibe Forge](https://github.com/L0nE-F0x/VibeForge) on ${date}.*`,
    "",
  ].join("\n");
}

/** A tool-agnostic kickoff prompt: paste into Claude Code / Cursor / Codex and go. */
export function kickoffPrompt(p: Project): string {
  return [
    "You are an expert software engineer with full tooling in this repository. Build the application described in the spec below — completely, and to a professional standard.",
    "",
    "Rules:",
    "- Scaffold the project yourself, following the spec's Tech Stack and Architecture sections.",
    "- Implement the FULL Feature Set — no placeholders, TODOs, or stubs.",
    "- Meet every item in Acceptance Criteria before you consider the task done.",
    "- Finish with brief instructions for running the app.",
    "",
    "--- SPEC ---",
    "",
    p.spec.trim(),
  ].join("\n");
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export function downloadMarkdown(p: Project): void {
  const blob = new Blob([specMarkdown(p)], { type: "text/markdown" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${p.slug}-spec.md`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
