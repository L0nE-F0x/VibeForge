// Render tools/og-image.html → web/public/og.png (the social-share card).
//
//   npm run og
//
// Uses whatever Chromium-based browser is already installed (Chrome or Edge) in
// headless mode — no extra dependencies. Renders at 2× for crisp text, producing
// a 2400×1260 PNG that keeps the 1.91:1 Open Graph aspect ratio.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const src = join(here, "og-image.html");
const out = join(root, "web", "public", "og.png");

const CANDIDATES = [
  process.env.CHROME_PATH,
  // Windows
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  // macOS
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  // Linux
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/usr/bin/microsoft-edge",
].filter(Boolean);

const browser = CANDIDATES.find((p) => existsSync(p));
if (!browser) {
  console.error("No Chrome/Edge found. Set CHROME_PATH to a Chromium-based browser binary.");
  process.exit(1);
}

const profile = mkdtempSync(join(tmpdir(), "vf-og-"));
const fileUrl = "file://" + src.replace(/\\/g, "/");

const args = [
  "--headless=new",
  "--disable-gpu",
  "--hide-scrollbars",
  "--no-sandbox",
  `--user-data-dir=${profile}`,
  "--force-device-scale-factor=2",
  "--window-size=1200,630",
  "--default-background-color=00000000",
  "--virtual-time-budget=6000", // give the web font time to load
  "--run-all-compositor-stages-before-draw",
  `--screenshot=${out}`,
  fileUrl,
];

console.log(`Rendering with: ${browser}`);
const r = spawnSync(browser, args, { stdio: "inherit" });
try { rmSync(profile, { recursive: true, force: true }); } catch {}

if (r.status !== 0 || !existsSync(out)) {
  console.error("Render failed.");
  process.exit(1);
}

console.log(`✓ Wrote ${out}`);
