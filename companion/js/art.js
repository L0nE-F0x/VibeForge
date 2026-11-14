// @ts-check
// The pixel art: the brand's mark and wordmark, the plans' marks, and the small glyphs. Copies of
// the desktop's (src/shared/pixel.ts), which the page can't import; tests/unit/companion.test.ts
// keeps them the same.

/** The desktop's plan marks (`PLAN_MARKS` in src/shared/pixel.ts). One colour, eleven pixels square. @type {Record<string, string[]>} */
const PLAN_MARKS = {
  grok: ["....###...#", "..##...###.", ".#......##.", "#......#..#", "#.....#...#", "#....#....#", "#...#.....#", ".#.#.....#.", "..##...##..", ".#..###....", "#.........."],
  claude: [".....#.....", ".....#.....", "..#..#..#..", "...#.#.#...", "....###....", "##.#####.##", "....###....", "...#.#.#...", "..#..#..#..", ".....#.....", ".....#....."],
  kimi: ["##.......##", "##......##.", "##.....##..", "##....##...", "##...##....", "##..##.....", "##.##......", "##..##.....", "##...##....", "##....##...", "##.....##.."],
  codex: ["...........", "##.........", ".##........", "..##.......", "...##......", "....##.....", "...##......", "..##.......", ".##........", "##...######", "..........."],
  agy: [".....#.....", ".....#.....", "....###....", "...#####...", "..#######..", "###########", "..#######..", "...#####...", "....###....", ".....#.....", ".....#....."],
  muse: ["#.#.....#.#", "##.#...#.##", "#.#.#.#.#.#", "#.#..#..#.#", "#.#.....#.#", "#.#.....#.#", "#.#.....#.#", "#.#.....#.#", "#.#.....#.#", "#.#.....#.#", "#.#.....#.#"],
};
/** The brand's pixel art (`MARK` and `GLYPHS` in src/shared/pixel.ts): the V-and-spark mark and the wordmark's letters. */
const MARK = [".....#.....", "....###....", ".....#.....", "##.......##", "##.......##", ".##.....##.", ".##.....##.", "..##...##..", "..##...##..", "...##.##...", "....###...."];
/** @type {Record<string, string[]>} */
const GLYPHS = {
  V: ["##..##", "##..##", "##..##", "##..##", ".####.", ".####.", "..##.."],
  I: ["######", "..##..", "..##..", "..##..", "..##..", "..##..", "######"],
  B: ["#####.", "##..##", "##..##", "#####.", "##..##", "##..##", "#####."],
  E: ["######", "##....", "##....", "#####.", "##....", "##....", "######"],
  F: ["######", "##....", "##....", "#####.", "##....", "##....", "##...."],
  O: [".####.", "##..##", "##..##", "##..##", "##..##", "##..##", ".####."],
  R: ["#####.", "##..##", "##..##", "#####.", "##.##.", "##..##", "##..##"],
  G: [".####.", "##..##", "##....", "##.###", "##..##", "##..##", ".#####"],
};

/** Pixel glyphs in one colour (the text's): a step's kind and state, a branch, leaving a step out, the mic. @type {Record<string, string[]>} */
const GLYPHS_SMALL = {
  start: ["#......", "###....", "#####..", "#######", "#####..", "###....", "#......"],
  tell: [".......", "#..#...", ".#..#..", "..#..#.", ".#..#..", "#..#...", "......."],
  stop: [".......", ".#####.", ".#####.", ".#####.", ".#####.", ".#####.", "......."],
  done: [".......", "......#", ".....#.", "#...#..", ".#.#...", "..#....", "......."],
  failed: ["...#...", "...#...", "...#...", "...#...", "...#...", ".......", "...#..."],
  remove: ["#.....#", ".#...#.", "..#.#..", "...#...", "..#.#..", ".#...#.", "#.....#"],
  branch: [".#...#.", ".#...#.", ".#..#..", ".#.#...", ".##....", ".#.....", ".#....."],
  workspace: ["##.....", "#######", "#.....#", "#..#..#", "#.###.#", "#..#..#", "#######"],
  apply: ["...#...", "...#...", ".#.#.#.", "..###..", "...#...", ".......", "#######"],
  discard: [".#####.", "#######", ".#.#.#.", ".#.#.#.", ".#.#.#.", ".#.#.#.", ".#####."],
  show: [".......", "..###..", ".#...#.", "#..#..#", ".#...#.", "..###..", "......."],
  lookup: [".###...", "#...#..", "#...#..", "#...#..", ".###...", "....#..", ".....#."],
  task: ["#......", "###....", "#####..", "#######", "#####..", "###....", "#......"],
  routine: ["#......", "###....", "#####..", "#######", "#####..", "###....", "#......"],
  mic: ["..###..", ".#####.", ".#####.", ".#####.", ".#####.", "#.###.#", "#.....#", ".#...#.", "..###..", "...#...", ".#####."],
};

/**
 * Which of four shades a row gets, lightest at the top (`shade` in src/shared/pixel.ts).
 * @param {number} y
 * @param {number} height
 */
function shade(y, height) {
  const at = height <= 1 ? 0 : y / (height - 1);
  return at <= 0.2 ? 0 : at < 0.45 ? 1 : at < 0.75 ? 2 : 3;
}

/**
 * Pixel art from rows of "#", `scale` screen pixels per cell. Shaded art takes the brand's four bands; plain art takes one colour.
 * @param {string[]} rows
 * @param {string} className
 * @param {number} scale
 */
function pixels(rows, className, scale, shaded = false) {
  const width = rows[0].length;
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", className);
  svg.setAttribute("viewBox", `0 0 ${width} ${rows.length}`);
  svg.setAttribute("width", String(width * scale));
  svg.setAttribute("height", String(rows.length * scale));
  svg.setAttribute("shape-rendering", "crispEdges");
  svg.setAttribute("aria-hidden", "true");
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x += 1) {
      if (row[x] !== "#") continue;
      const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
      rect.setAttribute("x", String(x));
      rect.setAttribute("y", String(y));
      rect.setAttribute("width", "1");
      rect.setAttribute("height", "1");
      if (shaded) rect.setAttribute("class", `shade-${shade(y, rows.length)}`);
      svg.append(rect);
    }
  });
  return svg;
}

/** @param {string} id */
export function planMark(id) {
  const rows = PLAN_MARKS[id];
  return rows ? pixels(rows, "plan-mark", 2) : null;
}

export function brandMark() {
  return pixels(MARK, "pixels mark", 2, true);
}

/**
 * "VIBEFORGE" in the seven-row pixel font, one blank column between letters (`wordmark` in src/shared/pixel.ts).
 * @param {string} [label]
 */
export function wordmark(label) {
  const letters = [..."VIBEFORGE"].map((char) => GLYPHS[char]);
  const rows = Array.from({ length: 7 }, (_, y) => letters.map((glyph) => glyph[y]).join("."));
  const svg = pixels(rows, "pixels wordmark", 5, true);
  if (label) {
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", label);
    svg.removeAttribute("aria-hidden");
    svg.setAttribute("width", "210");
    svg.setAttribute("height", "24");
  }
  return svg;
}

/**
 * @param {string} name
 * @param {number} [scale]
 */
export function glyph(name, scale = 2) {
  return pixels(GLYPHS_SMALL[name], `glyph glyph-${name}`, scale);
}
