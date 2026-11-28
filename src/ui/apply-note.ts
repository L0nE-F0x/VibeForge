import type { ApplyResult } from "../shared/api.js";
import { tildify } from "../shared/text.js";
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

/** What a clean Apply left only in the copy because git ignores it: the first few names, and where the copy is. */
export function applyLeftNote(t: Translator, left: { folder: string; files: string[] }, home: string): string {
  const shown = left.files.slice(0, 6).join(", ");
  return t("tasks.appliedLeftBody", { files: left.files.length > 6 ? `${shown}, …` : shown, folder: tildify(left.folder, home) });
}

/** The toast to show after Apply (for a task's or Viby's copy). */
export function applyToast(
  t: Translator,
  result: ApplyResult,
  workspace: string,
  home: string,
): { tone: "info" | "success" | "error"; title: string; body?: string } {
  if (!result.files.length && !result.left && !result.stayed) return { tone: "info", title: t(result.already ? "tasks.applyAlready" : "tasks.applyNothing") };
  if (result.conflicts.length) return { tone: "error", title: t("tasks.applyConflicts"), body: applyConflictNote(t, result) };
  // Files left unticked keep the copy; the main process doesn't look for ignored files then.
  if (result.stayed) {
    if (!result.files.length) return { tone: "info", title: t.count("tasks.appliedPartialStayed", result.stayed) };
    return {
      tone: "success",
      title: t("tasks.appliedLeft", { workspace }),
      body: `${t.count("tasks.appliedPartialApplied", result.files.length)} ${t.count("tasks.appliedPartialStayed", result.stayed)}`,
    };
  }
  if (result.pulled) {
    const { branch, upstream, alreadyUpToDate } = result.pulled;
    if (result.left) {
      return { tone: "info", title: t(alreadyUpToDate ? "tasks.alreadyMergedLeft" : "tasks.pulledLeft", { workspace }), body: applyLeftNote(t, result.left, home) };
    }
    return alreadyUpToDate
      ? { tone: "success", title: t("tasks.alreadyMerged", { workspace }), body: t("tasks.alreadyMergedBody", { branch }) }
      : { tone: "success", title: t("tasks.pulled", { workspace }), body: t("tasks.pulledBody", { branch, upstream }) };
  }
  if (result.left) return { tone: "info", title: t("tasks.appliedLeft", { workspace }), body: applyLeftNote(t, result.left, home) };
  return { tone: "success", title: t("tasks.applied", { workspace }), body: t.count("tasks.appliedBody", result.files.length) };
}
