import { describe, expect, it } from "vitest";
import { GLYPHS, identicon, MARK, mark, scatter, seeded, shade, vibyArt, wordmark, type VibyMood } from "../../src/shared/pixel.js";

describe("pixel art", () => {
  it("draws every glyph on the same seven-row grid", () => {
    for (const [char, rows] of Object.entries(GLYPHS)) {
      expect(rows, char).toHaveLength(7);
      expect(new Set(rows.map((row) => row.length)).size, `${char} rows are one width`).toBe(1);
    }
    expect(new Set(MARK.map((row) => row.length))).toEqual(new Set([MARK.length]));
  });

  it("sets VIBEFORGE as nine six-wide letters with one-pixel gaps", () => {
    const art = wordmark();
    expect(art.width).toBe(9 * 6 + 8);
    expect(art.height).toBe(7);
    expect(art.cells.every((cell) => cell.x >= 0 && cell.x < art.width && cell.y >= 0 && cell.y < art.height)).toBe(true);
    expect(mark()).toMatchObject({ width: 11, height: 11 });
  });

  it("shades from light at the top to deep at the bottom, the spark in the lightest band", () => {
    const bands = Array.from({ length: 7 }, (_, y) => shade(y, 7));
    expect(bands).toEqual([0, 0, 1, 2, 2, 3, 3]);
    expect([0, 1, 2].map((y) => shade(y, 11))).toEqual([0, 0, 0]);
  });

  it("scatters the same pixels for the same seed, and only inside the grid", () => {
    expect(Array.from({ length: 5 }, seeded(3))).toEqual(Array.from({ length: 5 }, seeded(3)));
    const a = scatter(20, 10, () => 0.5, 9);
    expect(scatter(20, 10, () => 0.5, 9)).toEqual(a);
    expect(a.length).toBeGreaterThan(40);
    expect(a.every((cell) => cell.x < 20 && cell.y < 10 && cell.strength > 0 && cell.strength <= 1)).toBe(true);
    expect(scatter(20, 10, () => 0)).toEqual([]);
  });

  it("gives each name the same mirrored face, and different names different faces", () => {
    const art = identicon("API reviewer");
    expect(identicon("API reviewer")).toEqual(art);
    expect(identicon("Site builder")).not.toEqual(art);
    const lit = new Set(art.cells.map((cell) => `${cell.x},${cell.y}`));
    for (const cell of art.cells) expect(lit.has(`${4 - cell.x},${cell.y}`)).toBe(true);
    expect(art.cells.length).toBeGreaterThanOrEqual(6);
    expect(art.cells.length).toBeLessThanOrEqual(20);
  });

  it("poses Viby as a 15x15 V-and-spark character across every call mood", () => {
    const moods: VibyMood[] = ["idle", "listening", "muted", "thinking", "speaking"];
    for (const mood of moods) {
      for (let frame = 0; frame < 4; frame += 1) {
        const art = vibyArt(mood, frame);
        expect(art.width).toBe(15);
        expect(art.height).toBe(15);
        expect(art.cells.every((cell) => cell.x >= 0 && cell.x < 15 && cell.y >= 0 && cell.y < 15)).toBe(true);
        expect(art.cells.some((cell) => cell.tone === "visor")).toBe(true);
        expect(art.cells.some((cell) => cell.tone === "eye")).toBe(true);
        // V tip anchors at (7, 14) on every frame.
        expect(art.cells.some((cell) => cell.x === 7 && cell.y === 14 && cell.tone === "s3")).toBe(true);
      }
    }
    // Symmetric resting pose is strictly mirrored left-to-right.
    const idle = vibyArt("idle", 0);
    const byKey = new Map(idle.cells.map((cell) => [`${cell.x},${cell.y}`, cell.tone]));
    for (const cell of idle.cells) {
      expect(byKey.get(`${14 - cell.x},${cell.y}`)).toBe(cell.tone);
    }
    // The body holds still in every pose (only the spark, arm tips and face change), so it doesn't jitter.
    const body = (mood: VibyMood, frame: number) =>
      vibyArt(mood, frame)
        .cells.filter((cell) => cell.y >= 5 && cell.tone !== "visor" && cell.tone !== "eye")
        .map((cell) => `${cell.x},${cell.y},${cell.tone}`)
        .sort()
        .join(" ");
    for (const mood of moods) for (let frame = 0; frame < 4; frame += 1) expect(body(mood, frame)).toBe(body("idle", 0));
    // Blink frame closes top row of eyes compared with open frame.
    expect(vibyArt("idle", 1).cells.filter((cell) => cell.tone === "eye").length).toBeLessThan(
      idle.cells.filter((cell) => cell.tone === "eye").length,
    );
  });
});
