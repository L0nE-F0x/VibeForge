import { SNIPPET_CLOSE, SNIPPET_OPEN } from "../shared/text.js";

// How well a typed query matches a name, for the switcher: -1 is no match, higher is better.
// Whole-substring matches beat scattered letters; a match at the start of the name or of a word
// beats one in the middle; shorter names win ties. "atl" finds Atlas, "rn" finds "release-notes".

function isWordStart(text: string, index: number): boolean {
  if (index === 0) return true;
  const before = text[index - 1];
  return /[\s\-_./·:]/.test(before) || (before === before.toLowerCase() && text[index] !== text[index].toLowerCase());
}

export function fuzzyScore(query: string, text: string): number {
  const q = query.trim().toLowerCase();
  if (!q) return 0;
  const lower = text.toLowerCase();
  const at = lower.indexOf(q);
  if (at >= 0) {
    let best = at;
    // Prefer an occurrence that starts a word ("notes" in "release-notes").
    for (let from = at; from >= 0; from = lower.indexOf(q, from + 1)) {
      if (isWordStart(text, from)) {
        best = from;
        break;
      }
    }
    return 1000 - (best === 0 ? 0 : isWordStart(text, best) ? 100 : 300) - best - text.length;
  }
  // Letters in order, anywhere: each one that starts a word counts for more.
  let score = 500;
  let from = 0;
  for (const char of q) {
    if (char === " ") continue;
    const found = lower.indexOf(char, from);
    if (found < 0) return -1;
    score += isWordStart(text, found) ? 10 : -(found - from);
    from = found + 1;
  }
  return Math.max(1, score - text.length);
}

/**
 * Where a task's, routine's or skill's text holds the query as typed (three letters or more):
 * the words around it, the match marked as a search snippet marks it. Null when it doesn't.
 */
export function textSnippet(query: string, text: string, around = 36): string | null {
  const q = query.trim().toLowerCase();
  if (q.length < 3 || !text) return null;
  const at = text.toLowerCase().indexOf(q);
  if (at < 0) return null;
  const start = Math.max(0, at - around);
  const end = Math.min(text.length, at + q.length + around);
  return `${start > 0 ? "…" : ""}${text.slice(start, at)}${SNIPPET_OPEN}${text.slice(at, at + q.length)}${SNIPPET_CLOSE}${text.slice(at + q.length, end)}${end < text.length ? "…" : ""}`;
}
