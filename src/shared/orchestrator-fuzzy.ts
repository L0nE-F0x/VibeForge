// Pure fuzzy, phonetic, homophone, acronym, and @mention matching for Viby's entity names.
// No Node imports so both main process, desktop UI, and phone companion can share it.

/** Frequent speech-to-text slips and homophones mapped to canonical spellings. */
export const CANONICAL_ALIASES: ReadonlyArray<readonly [string, string]> = [
  ["claud", "claude"],
  ["cloud", "claude"],
  ["clawd", "claude"],
  ["clawed", "claude"],
  ["clod", "claude"],
  ["claudecode", "claudecode"],
  ["cloudcode", "claudecode"],
  ["claudcode", "claudecode"],
  ["clawdcode", "claudecode"],
  ["codex", "codex"],
  ["codecs", "codex"],
  ["kodeks", "codex"],
  ["grok", "grok"],
  ["grock", "grok"],
  ["grockbuild", "grokbuild"],
  ["antigravity", "antigravity"],
  ["antigravitycli", "antigravitycli"],
  ["agy", "agy"],
  ["omarchy", "omarchy"],
  ["ohmarchy", "omarchy"],
  ["omarki", "omarchy"],
  ["hyprland", "hyprland"],
  ["hyperland", "hyprland"],
  ["vibeforge", "vibeforge"],
  ["vibeforje", "vibeforge"],
  ["vibeforg", "vibeforge"],
  ["viby", "viby"],
  ["vibey", "viby"],
  ["ledger", "ledger"],
  ["leger", "ledger"],
];

const ALIAS_MAP = new Map<string, string>(CANONICAL_ALIASES);

/** Strip `@mention` sigils, outer quotes, and combining diacritics while preserving non-Latin scripts. */
export function cleanQuery(raw: string | undefined): string {
  return (raw ?? "")
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .trim()
    .replace(/^['"`]+|['"`]+$/g, "")
    .replace(/^@+/, "")
    .trim();
}

export function squashName(value: string): string {
  return cleanQuery(value).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

export function splitWords(value: string): string[] {
  const spaced = cleanQuery(value).replace(/([\p{Ll}\p{N}])([\p{Lu}])/gu, "$1 $2");
  return spaced.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

/** Expand a squashed or multi-word string through canonical STT alias substitutions. */
export function canonicalizeName(value: string): string {
  const words = splitWords(value);
  if (!words.length) return "";
  const joined = words.join("");
  if (ALIAS_MAP.has(joined)) return ALIAS_MAP.get(joined)!;
  return words.map((w) => ALIAS_MAP.get(w) ?? w).join("");
}

function phoneticWord(word: string): string {
  const canonical = ALIAS_MAP.get(word) ?? word;
  if (/^\d+$/.test(canonical)) return canonical;
  // Non-Latin scripts keep their normalized characters untouched.
  if (/[^\x00-\x7f]/.test(canonical)) return canonical;
  let w = canonical
    .replace(/^(?:kn|gn)/, "n")
    .replace(/^wr/, "r")
    .replace(/^wh/, "w")
    .replace(/ph/g, "f")
    .replace(/qu/g, "kw")
    .replace(/ck/g, "k")
    .replace(/dg([eiy])/g, "j$1")
    .replace(/c([eiy])/g, "s$1")
    .replace(/c/g, "k")
    .replace(/q/g, "k")
    .replace(/x/g, "ks")
    .replace(/z/g, "s")
    .replace(/(?:ea|ee|ie)/g, "i")
    .replace(/(?:au|aw|oa|ow|ou)/g, "o")
    .replace(/(?:ai|ay|ei|ey)/g, "e")
    .replace(/oo/g, "u")
    .replace(/(.)\1+/g, "$1");
  if (w.length > 3 && w.endsWith("e")) w = w.slice(0, -1);
  return w;
}

/** Phonetic skeleton of a name for matching spoken homophones and minor misspellings. */
export function phoneticKey(value: string): string {
  return splitWords(value).map(phoneticWord).join("");
}

/** Optimal string alignment (Damerau-Levenshtein) similarity in [0, 1]. */
export function damerauSimilarity(a: string, b: string): number {
  if (!a && !b) return 1;
  if (!a || !b) return 0;
  if (a === b) return 1;
  const maxLen = Math.max(a.length, b.length);
  const rows = a.length + 1;
  const cols = b.length + 1;
  const d = Array.from({ length: rows }, () => new Array<number>(cols).fill(0));
  for (let i = 0; i < rows; i += 1) d[i][0] = i;
  for (let j = 0; j < cols; j += 1) d[0][j] = j;
  for (let i = 1; i < rows; i += 1) {
    for (let j = 1; j < cols; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let val = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        val = Math.min(val, d[i - 2][j - 2] + 1);
      }
      d[i][j] = val;
    }
  }
  return 1 - d[a.length][b.length] / maxLen;
}

function acronymOf(raw: string): string {
  const words = splitWords(raw);
  return words.length >= 2 ? words.map((w) => w[0]).join("") : "";
}

const GENERIC_WORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "app",
  "cli",
  "code",
  "agent",
  "skill",
  "task",
  "routine",
  "workspace",
  "project",
  "branch",
  "file",
  "chat",
  "run",
  "new",
]);

function meaningfulWords(raw: string): string[] {
  return splitWords(raw).filter((w) => w.length >= 4 && !GENERIC_WORDS.has(w));
}

function scorePair(query: string, candidate: string, byWord: boolean): number {
  const wanted = squashName(query);
  const cand = squashName(candidate);
  if (!wanted || !cand) return 0;
  if (cand === wanted) return 1;

  // Canonical homophone / STT slip expansion
  const canonWanted = canonicalizeName(query);
  const canonCand = canonicalizeName(candidate);
  if (canonWanted && canonCand) {
    if (canonCand === canonWanted) return 0.97;
    if (byWord && canonWanted.length >= 4 && canonCand.length >= 4 && (canonCand.includes(canonWanted) || canonWanted.includes(canonCand))) {
      return 0.93;
    }
  }

  // Phonetic skeleton equality (e.g. "star leger" -> "star ledger", "vibe forje" -> "vibeforge")
  if (wanted.length >= 4 && cand.length >= 4) {
    const phWanted = phoneticKey(query);
    const phCand = phoneticKey(candidate);
    const sim = damerauSimilarity(wanted, cand);
    if (phWanted.length >= 4 && phWanted === phCand && sim >= 0.6) {
      return 0.92 + sim * 0.04;
    }
  }

  // Acronym match ("vf" / "agy" for 2+ word names when wanted >= 3 chars)
  if (wanted.length >= 3 && wanted === acronymOf(candidate)) {
    return 0.89;
  }

  // Whole-word phonetic or typo match ("run tests on star leger", "ask clawd reviewer")
  if (byWord) {
    const qWords = meaningfulWords(query);
    const cWords = meaningfulWords(candidate);
    let bestWord = 0;
    let matchedCount = 0;
    for (const qw of qWords) {
      const qPhon = phoneticWord(canonicalizeName(qw));
      let wordMatched = false;
      for (const cw of cWords) {
        const cPhon = phoneticWord(canonicalizeName(cw));
        const wSim = damerauSimilarity(qw, cw);
        if (qw === cw || (canonicalizeName(qw) === canonicalizeName(cw) && canonicalizeName(qw).length >= 4)) {
          bestWord = Math.max(bestWord, qWords.length > 1 ? 0.86 : 0.9);
          wordMatched = true;
        } else if (qPhon.length >= 4 && qPhon === cPhon && wSim >= 0.65) {
          bestWord = Math.max(bestWord, 0.85);
          wordMatched = true;
        } else if (qw.length >= 5 && cw.length >= 5 && wSim >= 0.82) {
          bestWord = Math.max(bestWord, 0.8 + (wSim - 0.82) * 0.5);
          wordMatched = true;
        }
      }
      if (wordMatched) matchedCount += 1;
    }
    if (bestWord > 0) {
      return matchedCount >= qWords.length && qWords.length > 1 ? Math.max(bestWord, 0.92) : bestWord;
    }
  }

  // Direct edit-distance similarity for 4+ character names
  if (wanted.length >= 4 && cand.length >= 4) {
    const sim = damerauSimilarity(wanted, cand);
    const threshold = wanted.length === 4 || wanted.length === 5 ? 0.78 : 0.75;
    if (sim >= threshold) return 0.78 + (sim - threshold) * 0.8;
  }
  return 0;
}

/** Minimum score difference required between top-1 and top-2 candidates to avoid ambiguous auto-matching. */
export const FUZZY_AMBIGUITY_MARGIN = 0.06;

/**
 * Fallback fuzzy/phonetic matcher when exact, prefix, and substring tiers found zero candidates.
 * Returns `null` when nothing clears the confidence floor OR when two distinct items score too close together.
 */
export function fuzzyMatchName<T>(asked: string | undefined, items: readonly T[], names: (item: T) => string[], byWord = false): T | null {
  const cleanAsked = cleanQuery(asked);
  if (!cleanAsked || !items.length) return null;
  const scored: Array<{ item: T; score: number }> = [];
  for (const item of items) {
    let best = 0;
    for (const rawName of names(item)) {
      if (!rawName) continue;
      best = Math.max(best, scorePair(cleanAsked, rawName, byWord));
    }
    if (best >= 0.78) scored.push({ item, score: best });
  }
  if (!scored.length) return null;
  scored.sort((a, b) => b.score - a.score);
  if (scored.length === 1) return scored[0].item;
  if (scored[0].score - scored[1].score >= FUZZY_AMBIGUITY_MARGIN) return scored[0].item;
  return null;
}
