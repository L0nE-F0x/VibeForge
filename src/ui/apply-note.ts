import type { Translator } from "./i18n/index.js";

/**
 * What an Apply that didn't go in cleanly left behind: files with conflict markers to resolve, and
 * files kept as the workspace had them (a binary, or a file one side deleted). Tasks and Maestro say it alike.
 */
export function applyConflictNote(t: Translator, result: { conflicts: string[]; kept?: string[] }): string {
  const kept = result.kept ?? [];
  const marked = result.conflicts.filter((file) => !kept.includes(file));
  return [marked.length ? t("tasks.applyConflictsBody", { files: marked.join(", ") }) : "", kept.length ? t("tasks.applyKeptBody", { files: kept.join(", ") }) : ""]
    .filter(Boolean)
    .join(" ");
}
