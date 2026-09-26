// Dictated words on their way into a box: shared by the window and the main process.

/**
 * An initial prompt that nudges whisper toward the names on this desk (agents, CLIs, files).
 * Written as sentences: a bare list of words makes whisper drop punctuation.
 */
export function vocabularyPrompt(words: readonly string[], maxLength = 400): string {
  const seen = new Set<string>();
  const kept: string[] = [];
  let length = 0;
  for (const raw of words) {
    const word = raw.replace(/\s+/g, " ").trim();
    const key = word.toLowerCase();
    if (!word || word.length > 60 || seen.has(key)) continue;
    if (length + word.length + 2 > maxLength) break;
    seen.add(key);
    kept.push(word);
    length += word.length + 2;
  }
  // Examples of the commands teach whisper the wake word and its phrasing ("new task", not "New Desk").
  return `${kept.length ? `Names that may come up: ${kept.join(", ")}. ` : ""}Forge, new task: fix the bug. Forge, send.`;
}

/** Dictated words joined onto what is already in a box, with one space between. */
export function joinDictation(before: string, words: string): string {
  if (!before.trim()) return words;
  return /\s$/.test(before) ? before + words : `${before} ${words}`;
}
