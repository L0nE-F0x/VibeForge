// A run's change summary as the core writes it, from git's own English ("2 files changed,
// 3 insertions(+), 1 deletion(-) · 1 new file"), in the reader's language. Shared by the window and
// the main process's notifications.

export type ChangePart =
  | { kind: "commits" | "touched" | "new"; count: number }
  | { kind: "files"; count: number; plus: number; minus: number }
  | { kind: "none" };

const STAT = /^(\d+) files? changed(?:, (\d+) insertions?\(\+\))?(?:, (\d+) deletions?\(-\))?$/;
const COUNTED: Array<[RegExp, "commits" | "touched" | "new"]> = [
  [/^(\d+) commits?$/, "commits"],
  [/^(\d+) files? touched$/, "touched"],
  [/^(\d+) new files?$/, "new"],
];

/** The parts of a summary, or null when it isn't one the core wrote (it is then shown as it is). */
export function parseChanges(text: string): ChangePart[] | null {
  const parts: ChangePart[] = [];
  for (const part of text.split(" · ").map((item) => item.trim())) {
    if (part === "No changes") {
      parts.push({ kind: "none" });
      continue;
    }
    const stat = STAT.exec(part);
    if (stat) {
      parts.push({ kind: "files", count: Number(stat[1]), plus: Number(stat[2] ?? 0), minus: Number(stat[3] ?? 0) });
      continue;
    }
    const counted = COUNTED.find(([pattern]) => pattern.test(part));
    if (!counted) return null;
    parts.push({ kind: counted[1], count: Number(counted[0].exec(part)?.[1]) });
  }
  return parts.length ? parts : null;
}

export type ChangeCountKey = "changes.commits" | "changes.files" | "changes.touched" | "changes.newFiles";

export interface ChangeWords {
  count: (base: ChangeCountKey, count: number) => string;
  say: (key: "changes.none") => string;
}

const KEYS = { commits: "changes.commits", touched: "changes.touched", new: "changes.newFiles" } as const;

/** "2 files +3 −1 · 1 new file", in the words given. Anything else comes back as it was. */
export function changesText(text: string | null | undefined, words: ChangeWords): string | null {
  if (!text) return text ?? null;
  const parts = parseChanges(text);
  if (!parts) return text;
  return parts
    .map((part) => {
      if (part.kind === "none") return words.say("changes.none");
      if (part.kind === "files") return `${words.count("changes.files", part.count)}${part.plus || part.minus ? ` +${part.plus} −${part.minus}` : ""}`;
      return words.count(KEYS[part.kind], part.count);
    })
    .join(" · ");
}
