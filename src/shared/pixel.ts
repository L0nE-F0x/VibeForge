// Pixel art for the VibeForge brand, in the spirit of Omarchy's pixel wordmark: a 7-row bitmap
// font with two-pixel strokes, the V-and-spark mark, and seeded scatters of loose pixels. The
// app, the website, the icon and the social image all draw from this file, so they match.
// No imports: `node scripts/brand.ts` loads it directly.

export interface Cell {
  x: number;
  y: number;
}

export interface Art {
  cells: Cell[];
  width: number;
  height: number;
}

/** Seven rows tall; "#" is a pixel. */
export const GLYPHS: Record<string, string[]> = {
  V: ["##..##", "##..##", "##..##", "##..##", ".####.", ".####.", "..##.."],
  I: ["######", "..##..", "..##..", "..##..", "..##..", "..##..", "######"],
  B: ["#####.", "##..##", "##..##", "#####.", "##..##", "##..##", "#####."],
  E: ["######", "##....", "##....", "#####.", "##....", "##....", "######"],
  F: ["######", "##....", "##....", "#####.", "##....", "##....", "##...."],
  O: [".####.", "##..##", "##..##", "##..##", "##..##", "##..##", ".####."],
  R: ["#####.", "##..##", "##..##", "#####.", "##.##.", "##..##", "##..##"],
  G: [".####.", "##..##", "##....", "##.###", "##..##", "##..##", ".#####"],
};

/** The mark: the wordmark's V, wider, with the four-point spark above its notch (eleven pixels square). */
export const MARK = [
  ".....#.....",
  "....###....",
  ".....#.....",
  "##.......##",
  "##.......##",
  ".##.....##.",
  ".##.....##.",
  "..##...##..",
  "..##...##..",
  "...##.##...",
  "....###....",
];

/**
 * The coding plans' marks, eleven pixels square and drawn in one colour, for the usage panel:
 * Grok's slashed circle, Claude's starburst, Kimi's K and a prompt for Codex.
 */
export const PLAN_MARKS: Record<string, string[]> = {
  grok: [
    "....###...#",
    "..##...###.",
    ".#......##.",
    "#......#..#",
    "#.....#...#",
    "#....#....#",
    "#...#.....#",
    ".#.#.....#.",
    "..##...##..",
    ".#..###....",
    "#..........",
  ],
  claude: [
    ".....#.....",
    ".....#.....",
    "..#..#..#..",
    "...#.#.#...",
    "....###....",
    "##.#####.##",
    "....###....",
    "...#.#.#...",
    "..#..#..#..",
    ".....#.....",
    ".....#.....",
  ],
  kimi: [
    "##.......##",
    "##......##.",
    "##.....##..",
    "##....##...",
    "##...##....",
    "##..##.....",
    "##.##......",
    "##..##.....",
    "##...##....",
    "##....##...",
    "##.....##..",
  ],
  codex: [
    "...........",
    "##.........",
    ".##........",
    "..##.......",
    "...##......",
    "....##.....",
    "...##......",
    "..##.......",
    ".##........",
    "##...######",
    "...........",
  ],
};

export function planMark(id: string): Art | null {
  const rows = PLAN_MARKS[id];
  return rows ? { cells: cellsOf(rows), width: rows[0].length, height: rows.length } : null;
}

function cellsOf(rows: string[], ox = 0, oy = 0): Cell[] {
  const cells: Cell[] = [];
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) if (row[x] === "#") cells.push({ x: ox + x, y: oy + y });
  });
  return cells;
}

export function wordmark(text = "VIBEFORGE", gap = 1): Art {
  const cells: Cell[] = [];
  let x = 0;
  for (const char of text.toUpperCase()) {
    const glyph = GLYPHS[char];
    if (!glyph) {
      x += 3;
      continue;
    }
    cells.push(...cellsOf(glyph, x));
    x += glyph[0].length + gap;
  }
  return { cells, width: Math.max(0, x - gap), height: 7 };
}

export function mark(): Art {
  return { cells: cellsOf(MARK), width: MARK[0].length, height: MARK.length };
}

/**
 * Which of four shades a row gets, lightest at the top: the stepped bands of Omarchy's
 * wordmark. Shade 0 is the lightest tint, 1 the second accent, 2 the accent, 3 the deepest.
 */
export function shade(y: number, height: number): 0 | 1 | 2 | 3 {
  const t = height <= 1 ? 0 : y / (height - 1);
  return t <= 0.2 ? 0 : t < 0.45 ? 1 : t < 0.75 ? 2 : 3;
}

/** A small deterministic random source, so a pixel field looks the same on every render. */
export function seeded(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return ((state >>> 0) % 100_000) / 100_000;
  };
}

/**
 * Loose pixels on a cols × rows grid. `chance(x, y)` is the probability a cell lights up;
 * each lit cell gets a strength from 0 to 1, for its opacity.
 */
export function scatter(cols: number, rows: number, chance: (x: number, y: number) => number, seed = 7): Array<Cell & { strength: number }> {
  const random = seeded(seed);
  const out: Array<Cell & { strength: number }> = [];
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const p = chance(x, y);
      if (random() < p) out.push({ x, y, strength: 0.25 + random() * 0.75 });
    }
  }
  return out;
}
