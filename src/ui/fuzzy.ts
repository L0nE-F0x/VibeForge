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
