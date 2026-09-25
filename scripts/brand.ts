// Regenerates the brand assets from src/shared/pixel.ts, so the app, the icon, the website and
// the social image all show the same pixel art:
//
//   node scripts/brand.ts
//
// Writes resources/icon.svg and icon.png, site/assets/icon.svg, apple-touch-icon.png, og.svg and
// og.png, and the inline wordmark and marks in site/index.html (between brand:* markers). PNGs
// need rsvg-convert (librsvg); the OG text uses JetBrains Mono from the system.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { mark, scatter, shade, wordmark, type Art } from "../src/shared/pixel.ts";

const root = path.resolve(import.meta.dirname, "..");
const APEX = { bg: "#09090b", deep: "#050506", fg: "#ffffff", ash: "#71717a", accent: "#ff6b35", accent2: "#fca311" };
// The four shades, as the app computes them from Apex Forge (see --px-* in app.css).
const SHADES = ["#fddfad", APEX.accent2, APEX.accent, "#852d0f"];

function rects(art: Art, px: number, ox: number, oy: number, fill: (y: number) => string): string {
  return art.cells.map((c) => `<rect x="${ox + c.x * px}" y="${oy + c.y * px}" width="${px}" height="${px}" fill="${fill(c.y)}"/>`).join("");
}

function drift(cols: number, rows: number, cell: number, size: number, ox: number, oy: number, seed: number): string {
  return scatter(cols, rows, (x) => Math.min(0.85, Math.max(0, x / (cols - 1) - 0.3) ** 1.6 * 1.25), seed)
    .map((p) => `<rect x="${ox + p.x * cell}" y="${oy + p.y * cell}" width="${size}" height="${size}" fill="${APEX.accent}" opacity="${(p.strength * 0.6).toFixed(2)}"/>`)
    .join("");
}

function write(file: string, text: string): void {
  fs.writeFileSync(path.join(root, file), text);
  console.log("wrote", file);
}

function png(svgFile: string, pngFile: string, width: number): void {
  try {
    execFileSync("rsvg-convert", ["-w", String(width), path.join(root, svgFile), "-o", path.join(root, pngFile)]);
    console.log("wrote", pngFile);
  } catch {
    console.warn(`rsvg-convert is missing: ${pngFile} not updated`);
  }
}

// ---- the icon: the mark on near-black, framed by the accent gradient
const m = mark();
const iconPx = 32;
const iconOff = (512 - m.width * iconPx) / 2;
const icon = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512" shape-rendering="crispEdges">
  <defs><linearGradient id="edge" x1="0" y1="512" x2="512" y2="0" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="${APEX.accent}"/><stop offset="1" stop-color="${APEX.accent2}"/></linearGradient></defs>
  <rect width="512" height="512" fill="${APEX.bg}"/>
  <rect x="12" y="12" width="488" height="488" fill="none" stroke="url(#edge)" stroke-width="8"/>
  ${rects(m, iconPx, iconOff, iconOff, (y) => SHADES[shade(y, m.height)])}
</svg>
`;
write("resources/icon.svg", icon);
write("site/assets/icon.svg", icon);
png("resources/icon.svg", "resources/icon.png", 512);
png("resources/icon.svg", "site/assets/apple-touch-icon.png", 180);

// ---- the social image
const w = wordmark();
const ogPx = 13;
const ogX = 88;
const ogY = 214;
const og = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630" shape-rendering="crispEdges">
  <rect width="1200" height="630" fill="${APEX.bg}"/>
  ${drift(32, 42, 15, 9, 720, 0, 23)}
  <rect x="0" y="0" width="1200" height="4" fill="${APEX.accent}"/>
  ${rects(m, 6, ogX, 96, (y) => SHADES[shade(y, m.height)])}
  <text x="${ogX + m.width * 6 + 18}" y="131" font-family="JetBrainsMono Nerd Font, JetBrains Mono, monospace" font-size="24" fill="${APEX.ash}">vibe-forge.net</text>
  ${rects(w, ogPx, ogX, ogY, (y) => SHADES[shade(y, w.height)])}
  <text x="${ogX}" y="${ogY + 7 * ogPx + 78}" font-family="JetBrainsMono Nerd Font, JetBrains Mono, monospace" font-size="36" font-weight="600" fill="${APEX.fg}">Your coding agents, forged into one desk.</text>
  <text x="${ogX}" y="${ogY + 7 * ogPx + 128}" font-family="JetBrainsMono Nerd Font, JetBrains Mono, monospace" font-size="23" fill="${APEX.ash}">Claude Code, Codex, Grok and every CLI you use, as a team. For Omarchy.</text>
  <rect x="${ogX}" y="552" width="14" height="14" fill="${APEX.accent}"/>
  <text x="${ogX + 26}" y="565" font-family="JetBrainsMono Nerd Font, JetBrains Mono, monospace" font-size="20" fill="${APEX.ash}">open source · no accounts · no keys · no telemetry</text>
</svg>
`;
write("site/assets/og.svg", og);
png("site/assets/og.svg", "site/assets/og.png", 1200);

// ---- inline art for the website: fills are CSS variables, so it follows the page's theme
function inline(art: Art, px: number, className: string, label?: string): string {
  const cells = art.cells.map((c) => `<rect x="${c.x}" y="${c.y}" width="1" height="1" class="px-s${shade(c.y, art.height)}"/>`).join("");
  const a11y = label ? `role="img" aria-label="${label}"` : `aria-hidden="true"`;
  return `<svg class="${className}" viewBox="0 0 ${art.width} ${art.height}" width="${art.width * px}" height="${art.height * px}" shape-rendering="crispEdges" ${a11y}>${cells}</svg>`;
}

const pagePath = path.join(root, "site/index.html");
let page = fs.readFileSync(pagePath, "utf8");
const blocks: Record<string, string> = {
  wordmark: inline(w, 16, "wordmark", "VibeForge"),
  mark: inline(m, 2, "mark"),
  "mark-large": inline(m, 8, "mark-large"),
};
for (const [name, svg] of Object.entries(blocks)) {
  const pattern = new RegExp(`(<!-- brand:${name} -->)[\\s\\S]*?(<!-- /brand:${name} -->)`, "g");
  let count = 0;
  page = page.replace(pattern, (_all, open: string, close: string) => {
    count += 1;
    return `${open}${svg}${close}`;
  });
  console.log(`site/index.html: ${count} × brand:${name}`);
}
fs.writeFileSync(pagePath, page);
