// VibeForge's icon in the theme's colours: the pixel V and spark from src/shared/pixel.ts on the
// theme's background, framed by its accent gradient, as scripts/brand.ts draws resources/icon.png
// in Apex Forge's. Notifications, the tray and the app launcher show it, so they change with the
// theme as the window's own logo does. No Electron here: it makes PNG bytes and SVG text.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { mark, shade } from "../shared/pixel.js";
import type { Palette } from "./theme.js";

export type IconColors = Pick<Palette, "mode" | "accent" | "accent2" | "background">;

/** The colours the icon is drawn from; two palettes with the same ones draw the same icon. */
export function iconColors(palette: IconColors): IconColors {
  return { mode: palette.mode, accent: palette.accent, accent2: palette.accent2, background: palette.background };
}

type Rgb = [number, number, number];

/** "#rgb", "#rrggbb" or "#rrggbbaa" (its alpha dropped); null for anything else. */
function parseHex(value: string): Rgb | null {
  const hex = value.trim().replace(/^#/, "");
  const full = hex.length === 3 ? [...hex].map((c) => c + c).join("") : hex.slice(0, 6);
  if (!/^[0-9a-f]{6}$/i.test(full) || (hex.length !== 3 && hex.length !== 6 && hex.length !== 8)) return null;
  return [0, 2, 4].map((at) => Number.parseInt(full.slice(at, at + 2), 16)) as Rgb;
}

const FALLBACK = { accent: [0xff, 0x6b, 0x35] as Rgb, accent2: [0xfc, 0xa3, 0x11] as Rgb, background: [0x09, 0x09, 0x0b] as Rgb };

/** CSS's color-mix(in srgb, a share%, b). */
function mix(a: Rgb, share: number, b: Rgb): Rgb {
  return [0, 1, 2].map((i) => Math.round(a[i] * share + b[i] * (1 - share))) as Rgb;
}

const WHITE: Rgb = [255, 255, 255];
const BLACK: Rgb = [0, 0, 0];

/**
 * The mark's four shades, lightest band first, mixed as --px-0 … --px-3 in base.css: a dark
 * theme steps from a pale second accent down to a deep accent, a light theme the other way.
 */
export function markShades(colors: IconColors): [Rgb, Rgb, Rgb, Rgb] {
  const accent = parseHex(colors.accent) ?? FALLBACK.accent;
  const accent2 = parseHex(colors.accent2) ?? FALLBACK.accent2;
  if (colors.mode === "light") return [mix(accent, 0.5, BLACK), accent, accent2, mix(accent2, 0.45, WHITE)];
  return [mix(accent2, 0.42, WHITE), accent2, accent, mix(accent, 0.52, BLACK)];
}

/**
 * The icon as RGBA pixels, `size` square (512 is the full design; other sizes scale it): the
 * background, an 8-pixel frame 8 pixels in from the edge in the accent gradient (accent at the
 * bottom left to the second accent at the top right), and the 11-by-11 mark at 32 pixels a cell.
 */
export function iconRgba(colors: IconColors, size: number): Buffer {
  const k = size / 512;
  const background = parseHex(colors.background) ?? FALLBACK.background;
  const accent = parseHex(colors.accent) ?? FALLBACK.accent;
  const accent2 = parseHex(colors.accent2) ?? FALLBACK.accent2;
  const shades = markShades(colors);
  const out = Buffer.alloc(size * size * 4);
  const put = (x: number, y: number, [r, g, b]: Rgb) => {
    const at = (y * size + x) * 4;
    out[at] = r;
    out[at + 1] = g;
    out[at + 2] = b;
    out[at + 3] = 255;
  };
  const outer = [Math.round(8 * k), Math.round(504 * k)];
  const inner = [Math.round(16 * k), Math.round(496 * k)];
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const inFrame = x >= outer[0] && x < outer[1] && y >= outer[0] && y < outer[1] && !(x >= inner[0] && x < inner[1] && y >= inner[0] && y < inner[1]);
      if (!inFrame) {
        put(x, y, background);
        continue;
      }
      // Along the diagonal from the bottom-left corner to the top-right one.
      const t = Math.min(1, Math.max(0, (x + 0.5 + size - (y + 0.5)) / (2 * size)));
      put(x, y, [0, 1, 2].map((i) => Math.round(accent[i] + (accent2[i] - accent[i]) * t)) as Rgb);
    }
  }
  const art = mark();
  const cell = 32 * k;
  const offset = (size - art.width * cell) / 2;
  for (const { x, y } of art.cells) {
    const color = shades[shade(y, art.height)];
    const x0 = Math.round(offset + x * cell);
    const y0 = Math.round(offset + y * cell);
    const x1 = Math.round(offset + (x + 1) * cell);
    const y1 = Math.round(offset + (y + 1) * cell);
    for (let py = y0; py < y1; py += 1) for (let px = x0; px < x1; px += 1) put(px, py, color);
  }
  return out;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let i = 0; i < 8; i += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(data: Buffer): number {
  let c = 0xffffffff;
  for (const byte of data) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

/** RGBA pixels as a PNG file. */
export function encodePng(rgba: Buffer, width: number, height: number): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bits per channel
  header[9] = 6; // RGBA
  const rows = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) rgba.copy(rows, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", header), chunk("IDAT", zlib.deflateSync(rows, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}

export function iconPng(colors: IconColors, size: number): Buffer {
  return encodePng(iconRgba(colors, size), size, size);
}

const hexOf = (rgb: Rgb) => `#${rgb.map((c) => c.toString(16).padStart(2, "0")).join("")}`;

/** The same icon as SVG, for the launcher's scalable copy. */
export function iconSvg(colors: IconColors): string {
  const background = hexOf(parseHex(colors.background) ?? FALLBACK.background);
  const accent = hexOf(parseHex(colors.accent) ?? FALLBACK.accent);
  const accent2 = hexOf(parseHex(colors.accent2) ?? FALLBACK.accent2);
  const shades = markShades(colors).map(hexOf);
  const art = mark();
  const cells = art.cells.map((c) => `<rect x="${80 + c.x * 32}" y="${80 + c.y * 32}" width="32" height="32" fill="${shades[shade(c.y, art.height)]}"/>`).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512" shape-rendering="crispEdges">
  <defs><linearGradient id="edge" x1="0" y1="512" x2="512" y2="0" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="${accent}"/><stop offset="1" stop-color="${accent2}"/></linearGradient></defs>
  <rect width="512" height="512" fill="${background}"/>
  <rect x="12" y="12" width="488" height="488" fill="none" stroke="url(#edge)" stroke-width="8"/>
  ${cells}
</svg>
`;
}

/**
 * The app launcher's icons in the theme's colours. Only the ones scripts/install.sh made are
 * touched, and only while its launcher entry names its own icon: an entry or icon put there some
 * other way is someone else's and stays as it is. Files already right aren't written again.
 * Returns the files written.
 */
export function refreshLauncherIcons(colors: IconColors, home = os.homedir()): string[] {
  const share = path.join(home, ".local", "share");
  const hicolor = path.join(share, "icons", "hicolor");
  const big = path.join(hicolor, "512x512", "apps", "vibeforge.png");
  let entry: string;
  try {
    entry = fs.readFileSync(path.join(share, "applications", "vibeforge.desktop"), "utf8");
  } catch {
    return [];
  }
  const named = /^Icon=(.+)$/m.exec(entry)?.[1]?.trim() ?? "";
  if (!named || path.resolve(named) !== path.resolve(big)) return [];
  const icons: Array<[string, () => Buffer]> = [
    [big, () => iconPng(colors, 512)],
    [path.join(hicolor, "256x256", "apps", "vibeforge.png"), () => iconPng(colors, 256)],
    [path.join(hicolor, "scalable", "apps", "vibeforge.svg"), () => Buffer.from(iconSvg(colors))],
  ];
  const written: string[] = [];
  for (const [file, make] of icons) {
    if (!fs.existsSync(file)) continue;
    const data = make();
    let current: Buffer | null = null;
    try {
      current = fs.readFileSync(file);
    } catch {
      current = null;
    }
    if (current?.equals(data)) continue;
    const temp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, data);
    fs.renameSync(temp, file);
    written.push(file);
  }
  return written;
}
