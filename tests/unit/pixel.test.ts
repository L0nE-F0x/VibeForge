import { describe, expect, it } from "vitest";
import { GLYPHS, MARK, mark, scatter, seeded, shade, wordmark } from "../../src/shared/pixel.js";

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
});
