import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { iconColors, iconPng, iconSvg, markShades, refreshLauncherIcons, type IconColors } from "../../src/core/brand-icon.js";
import { BUILTIN_PALETTE } from "../../src/core/theme.js";

/** The pixels of a PNG this module wrote: 8-bit RGBA rows, each behind a 0 filter byte. */
function decode(png: Buffer): { width: number; height: number; at: (x: number, y: number) => string } {
  expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  let offset = 8;
  let width = 0;
  let height = 0;
  const idat: Buffer[] = [];
  while (offset < png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.toString("ascii", offset + 4, offset + 8);
    const data = png.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      expect([data[8], data[9]]).toEqual([8, 6]);
    }
    if (type === "IDAT") idat.push(data);
    offset += 12 + length;
  }
  const rows = zlib.inflateSync(Buffer.concat(idat));
  const at = (x: number, y: number) => {
    const i = y * (width * 4 + 1) + 1 + x * 4;
    expect(rows[i - 1 - x * 4]).toBe(0);
    return `#${[rows[i], rows[i + 1], rows[i + 2]].map((c) => c.toString(16).padStart(2, "0")).join("")}`;
  };
  return { width, height, at };
}

const hex = (rgb: number[]) => `#${rgb.map((c) => c.toString(16).padStart(2, "0")).join("")}`;
const tokyo: IconColors = { mode: "dark", accent: "#7aa2f7", accent2: "#bb9af7", background: "#1a1b26" };
const latte: IconColors = { mode: "light", accent: "#1e66f5", accent2: "#df8e1d", background: "#eff1f5" };

describe("VibeForge's icon in the theme's colours", () => {
  it("mixes the mark's shades as the app's --px-0 … --px-3 do, the other way round in a light theme", () => {
    expect(markShades(tokyo).map(hex)).toEqual(["#e2d5fc", "#bb9af7", "#7aa2f7", "#3f5480"]);
    expect(markShades(latte).map(hex)).toEqual(["#0f337b", "#1e66f5", "#df8e1d", "#f1cc99"]);
    // A colour it can't read falls back to Apex Forge's, never to nothing.
    expect(markShades({ ...tokyo, accent: "nope" })[2]).toEqual([0xff, 0x6b, 0x35]);
  });

  it("draws the background, the gradient frame and the mark, at any size", () => {
    const icon = decode(iconPng(tokyo, 512));
    expect([icon.width, icon.height]).toEqual([512, 512]);
    expect(icon.at(0, 0)).toBe("#1a1b26");
    expect(icon.at(40, 256)).toBe("#1a1b26");
    // The frame: the accent at the bottom left, the second accent at the top right.
    expect(icon.at(8, 503)).toBe("#7ba2f7");
    expect(icon.at(503, 8)).toBe("#ba9af7");
    // The spark's top pixel is the lightest shade; the V's point is the deepest.
    expect(icon.at(256, 96)).toBe("#e2d5fc");
    expect(icon.at(256, 416)).toBe("#3f5480");
    const small = decode(iconPng(tokyo, 256));
    expect([small.width, small.at(128, 48), small.at(128, 208), small.at(0, 0)]).toEqual([256, "#e2d5fc", "#3f5480", "#1a1b26"]);
    expect(decode(iconPng(latte, 256)).at(128, 48)).toBe("#0f337b");
  });

  it("draws the same icon for two palettes with the same colours, and its SVG has them too", () => {
    expect(iconColors({ ...BUILTIN_PALETTE })).toEqual({ mode: "dark", accent: "#ff6b35", accent2: "#fca311", background: "#09090b" });
    expect(iconPng(tokyo, 64).equals(iconPng({ ...tokyo }, 64))).toBe(true);
    const svg = iconSvg(tokyo);
    expect(svg).toContain('fill="#1a1b26"');
    expect(svg).toContain('stop-color="#7aa2f7"');
    expect(svg).toContain('fill="#e2d5fc"');
  });
});

describe("the launcher's icons", () => {
  const homes: string[] = [];
  afterEach(() => {
    for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true });
  });

  /** A home as scripts/install.sh leaves it: the entry naming its 512 icon, and the icons it copied. */
  function installed(icon?: string): { home: string; big: string; small: string; svg: string } {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "vibeforge-icon-"));
    homes.push(home);
    const share = path.join(home, ".local", "share");
    const big = path.join(share, "icons", "hicolor", "512x512", "apps", "vibeforge.png");
    const small = path.join(share, "icons", "hicolor", "256x256", "apps", "vibeforge.png");
    const svg = path.join(share, "icons", "hicolor", "scalable", "apps", "vibeforge.svg");
    for (const file of [big, small, svg]) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, "the old logo");
    }
    fs.mkdirSync(path.join(share, "applications"), { recursive: true });
    fs.writeFileSync(path.join(share, "applications", "vibeforge.desktop"), `[Desktop Entry]\nName=VibeForge\nIcon=${icon ?? big}\n`);
    return { home, big, small, svg };
  }

  it("redraws the installer's icons in the theme's colours, and leaves them be once they are", () => {
    const { home, big, small, svg } = installed();
    expect(refreshLauncherIcons(tokyo, home).sort()).toEqual([big, small, svg].sort());
    expect(decode(fs.readFileSync(big)).at(256, 96)).toBe("#e2d5fc");
    expect(decode(fs.readFileSync(small)).width).toBe(256);
    expect(fs.readFileSync(svg, "utf8")).toContain("#7aa2f7");
    expect(refreshLauncherIcons(tokyo, home)).toEqual([]);
    expect(refreshLauncherIcons(latte, home)).toHaveLength(3);
    // Nothing is left behind from the writes.
    expect(fs.readdirSync(path.dirname(big))).toEqual(["vibeforge.png"]);
  });

  it("makes no icon the installer didn't, and touches nothing when the entry names another icon or is missing", () => {
    const own = installed();
    fs.rmSync(own.small);
    expect(refreshLauncherIcons(tokyo, own.home).sort()).toEqual([own.big, own.svg].sort());
    expect(fs.existsSync(own.small)).toBe(false);

    const other = installed("/usr/share/icons/hicolor/512x512/apps/vibeforge.png");
    expect(refreshLauncherIcons(tokyo, other.home)).toEqual([]);
    expect(fs.readFileSync(other.big, "utf8")).toBe("the old logo");

    const none = installed();
    fs.rmSync(path.join(none.home, ".local", "share", "applications", "vibeforge.desktop"));
    expect(refreshLauncherIcons(tokyo, none.home)).toEqual([]);
    expect(fs.readFileSync(none.big, "utf8")).toBe("the old logo");
  });
});
