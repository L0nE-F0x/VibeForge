// VibeForge site. No framework, no tracking. Themes are the palettes VibeForge itself derives
// from Omarchy's theme files (generated with src/core/theme.ts); press T to flip through them,
// as on omarchy.org.

const THEMES = [
  {"id": "apex-forge", "name": "Apex Forge", "mode": "dark", "bg": "#09090b", "bgDark": "#0c0c0e", "bgDeep": "#050506", "bgRaised": "#151518", "fg": "#ffffff", "fg2": "#a1a1aa", "fg3": "#71717a", "accent": "#ff6b35", "accent2": "#fca311", "red": "#ff4d6d", "green": "#34d399", "yellow": "#fca311", "blue": "#38bdf8", "cyan": "#22d3ee", "magenta": "#7c3aed"},
  {"id": "tokyo-night", "name": "Tokyo Night", "mode": "dark", "bg": "#1a1b26", "bgDark": "#13141c", "bgDeep": "#0e0e14", "bgRaised": "#24283b", "fg": "#a9b1d6", "fg2": "#b4bee6", "fg3": "#6b7294", "accent": "#7aa2f7", "accent2": "#449dab", "red": "#f7768e", "green": "#9ece6a", "yellow": "#e0af68", "blue": "#7aa2f7", "cyan": "#449dab", "magenta": "#ad8ee6"},
  {"id": "catppuccin", "name": "Catppuccin", "mode": "dark", "bg": "#1e1e2e", "bgDark": "#161622", "bgDeep": "#101019", "bgRaised": "#313244", "fg": "#cdd6f4", "fg2": "#bac2de", "fg3": "#6f748a", "accent": "#89b4fa", "accent2": "#94e2d5", "red": "#f38ba8", "green": "#a6e3a1", "yellow": "#f9e2af", "blue": "#89b4fa", "cyan": "#94e2d5", "magenta": "#f5c2e7"},
  {"id": "gruvbox", "name": "Gruvbox", "mode": "dark", "bg": "#282828", "bgDark": "#1e1e1e", "bgDeep": "#161616", "bgRaised": "#3c3836", "fg": "#d4be98", "fg2": "#bdae93", "fg3": "#877968", "accent": "#7daea3", "accent2": "#89b482", "red": "#ea6962", "green": "#a9b665", "yellow": "#d8a657", "blue": "#7daea3", "cyan": "#89b482", "magenta": "#d3869b"},
  {"id": "nord", "name": "Nord", "mode": "dark", "bg": "#2e3440", "bgDark": "#222730", "bgDeep": "#191c23", "bgRaised": "#3b4252", "fg": "#d8dee9", "fg2": "#adb5c4", "fg3": "#7d8696", "accent": "#81a1c1", "accent2": "#88c0d0", "red": "#bf616a", "green": "#a3be8c", "yellow": "#ebcb8b", "blue": "#81a1c1", "cyan": "#88c0d0", "magenta": "#b48ead"},
  {"id": "everforest", "name": "Everforest", "mode": "dark", "bg": "#2d353b", "bgDark": "#21272c", "bgDeep": "#181d20", "bgRaised": "#343f44", "fg": "#d3c6aa", "fg2": "#9da9a0", "fg3": "#8d8c81", "accent": "#7fbbb3", "accent2": "#83c092", "red": "#e67e80", "green": "#a7c080", "yellow": "#dbbc7f", "blue": "#7fbbb3", "cyan": "#83c092", "magenta": "#d699b6"},
  {"id": "kanagawa", "name": "Kanagawa", "mode": "dark", "bg": "#1f1f28", "bgDark": "#17171e", "bgDeep": "#111116", "bgRaised": "#223249", "fg": "#dcd7ba", "fg2": "#c8c093", "fg3": "#767580", "accent": "#dcd7ba", "accent2": "#c0a36e", "red": "#c34043", "green": "#76946a", "yellow": "#c0a36e", "blue": "#7e9cd8", "cyan": "#6a9589", "magenta": "#957fb8"},
  {"id": "ristretto", "name": "Ristretto", "mode": "dark", "bg": "#2c2525", "bgDark": "#211b1b", "bgDeep": "#181414", "bgRaised": "#3d2f2a", "fg": "#e6d9db", "fg2": "#c3b7b8", "fg3": "#837a7b", "accent": "#f38d70", "accent2": "#fd6883", "red": "#fd6883", "green": "#adda78", "yellow": "#f9cc6c", "blue": "#f38d70", "cyan": "#85dacc", "magenta": "#a8a9eb"},
  {"id": "osaka-jade", "name": "Osaka Jade", "mode": "dark", "bg": "#111c18", "bgDark": "#0c1512", "bgDeep": "#090f0d", "bgRaised": "#23372b", "fg": "#c1c497", "fg2": "#d6d5bc", "fg3": "#647664", "accent": "#509475", "accent2": "#549e6a", "red": "#ff5345", "green": "#549e6a", "yellow": "#459451", "blue": "#509475", "cyan": "#2dd5b7", "magenta": "#d2689c"},
  {"id": "matte-black", "name": "Matte Black", "mode": "dark", "bg": "#121212", "bgDark": "#0d0d0d", "bgDeep": "#090909", "bgRaised": "#1e1e1e", "fg": "#bebebe", "fg2": "#8a8a8d", "fg3": "#6b6b6b", "accent": "#e68e0d", "accent2": "#d35f5f", "red": "#d35f5f", "green": "#ffc107", "yellow": "#b91c1c", "blue": "#e68e0d", "cyan": "#bebebe", "magenta": "#d35f5f"},
  {"id": "hackerman", "name": "Hackerman", "mode": "dark", "bg": "#0b0c16", "bgDark": "#080910", "bgDeep": "#06060c", "bgRaised": "#151828", "fg": "#ddf7ff", "fg2": "#b5c5db", "fg3": "#626f85", "accent": "#82fb9c", "accent2": "#2ec27e", "red": "#50f872", "green": "#4fe88f", "yellow": "#50f7d4", "blue": "#829dd4", "cyan": "#7cf8f7", "magenta": "#86a7df"},
  {"id": "rose-pine", "name": "Rosé Pine", "mode": "light", "bg": "#faf4ed", "bgDark": "#ede7e1", "bgDeep": "#e1dbd5", "bgRaised": "#f2e9e1", "fg": "#575279", "fg2": "#6e6a86", "fg3": "#817c96", "accent": "#56949f", "accent2": "#ea9d34", "red": "#b4637a", "green": "#286983", "yellow": "#ea9d34", "blue": "#56949f", "cyan": "#d7827e", "magenta": "#907aa9"},
  {"id": "catppuccin-latte", "name": "Catppuccin Latte", "mode": "light", "bg": "#eff1f5", "bgDark": "#e3e4e8", "bgDeep": "#d7d8dc", "bgRaised": "#dce0e8", "fg": "#4c4f69", "fg2": "#5c5f77", "fg3": "#7c8094", "accent": "#1e66f5", "accent2": "#179299", "red": "#d20f39", "green": "#40a02b", "yellow": "#df8e1d", "blue": "#1e66f5", "cyan": "#179299", "magenta": "#ea76cb"},
];

const REPO = "L0nE-F0x/VibeForge";
const RAW_INSTALL = `https://raw.githubusercontent.com/${REPO}/main/scripts/install.sh`;
const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
let currentTheme = THEMES[0].id;

// ------------------------------------------------------------------ themes

function luminance(hex) {
  const [r, g, b] = [1, 3, 5]
    .map((index) => parseInt(hex.slice(index, index + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a, b) {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light + 0.05) / (dark + 0.05);
}

/** Text on an accent button: the theme's darkest colour or white, whichever reads better on both accents. */
function onAccent(theme) {
  const score = (text) => Math.min(contrast(text, theme.accent), contrast(text, theme.accent2));
  return score(theme.bgDeep) >= score("#ffffff") ? theme.bgDeep : "#ffffff";
}

function applyTheme(id, { save = true } = {}) {
  const theme = THEMES.find((item) => item.id === id) ?? THEMES[0];
  currentTheme = theme.id;
  const root = document.documentElement;
  const set = (name, value) => root.style.setProperty(name, value);
  set("--bg", theme.bg);
  set("--bg-dark", theme.bgDark);
  set("--bg-deep", theme.bgDeep);
  set("--bg-raised", theme.bgRaised);
  set("--fg", theme.fg);
  set("--fg-2", theme.fg2);
  set("--fg-3", theme.fg3);
  set("--accent", theme.accent);
  set("--accent-2", theme.accent2);
  set("--on-accent", onAccent(theme));
  set("--green", theme.green);
  set("--red", theme.red);
  root.dataset.mode = theme.mode;
  $('meta[name="theme-color"]')?.setAttribute("content", theme.bg);
  for (const button of $$("[data-theme-id]")) button.setAttribute("aria-pressed", String(button.dataset.themeId === theme.id));
  const next = $("[data-theme-next]");
  if (next) next.title = `Theme: ${theme.name}. Press T for the next one.`;
  if (save) {
    try {
      localStorage.setItem("vibeforge.theme", theme.id);
    } catch {
      /* private mode */
    }
  }
}

function nextTheme(step = 1) {
  const index = THEMES.findIndex((theme) => theme.id === currentTheme);
  applyTheme(THEMES[(index + step + THEMES.length) % THEMES.length].id);
}

function setupThemes() {
  const list = $("[data-theme-list]");
  THEMES.forEach((theme, index) => {
    if (!list) return;
    if (index) list.insertAdjacentHTML("beforeend", '<span class="sep">/</span>');
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.themeId = theme.id;
    button.textContent = theme.name;
    button.addEventListener("click", () => applyTheme(theme.id));
    list.append(button);
  });
  $("[data-theme-next]")?.addEventListener("click", () => nextTheme());
  document.addEventListener("keydown", (event) => {
    const typing = event.target instanceof HTMLElement && event.target.closest("input, textarea, [contenteditable]");
    if (typing || event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.key === "t") nextTheme(1);
    else if (event.key === "T") nextTheme(-1);
  });
  let saved = null;
  try {
    saved = localStorage.getItem("vibeforge.theme");
  } catch {
    /* private mode */
  }
  applyTheme(saved ?? THEMES[0].id, { save: false });
}

// ------------------------------------------------------------------ pixel drift
// Loose squares thickening toward the edges, as around Omarchy's hero. Seeded, so the pattern
// is the same on every visit; the fill is the theme's accent.

function seeded(seed) {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return ((state >>> 0) % 100000) / 100000;
  };
}

function drawDrift(svg) {
  const cell = 18;
  const size = 11;
  const { width, height } = svg.getBoundingClientRect();
  const cols = Math.ceil(width / cell);
  const rows = Math.ceil(height / cell);
  const random = seeded(29);
  const mode = svg.dataset.drift || "sides";
  let rects = "";
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const side = Math.min(x, cols - 1 - x) / (cols / 2);
      const low = y / Math.max(1, rows - 1);
      // Thick along the edges and the bottom, thinning toward the middle so text stays clear.
      // The side bands are capped in pixels, so a phone gets a thin fringe rather than a wall.
      const band = Math.min(mode === "bottom" ? 200 : 260, width * (mode === "bottom" ? 0.14 : 0.18));
      const sides = Math.max(1 - (Math.min(x, cols - 1 - x) * cell) / band, 0) * 0.85;
      const floor = mode === "bottom" ? Math.max(0, (low - 0.7) / 0.3) * (0.35 + (1 - side) * 0.65) : low ** 3 * 0.55 * (1 - side * 0.9);
      const edge = sides + floor;
      const chance = Math.min(0.8, Math.max(0, edge - 0.18) ** 1.5);
      const roll = random();
      const strength = random();
      if (roll < chance) rects += `<rect x="${x * cell}" y="${y * cell}" width="${size}" height="${size}" opacity="${(0.12 + strength * 0.55).toFixed(2)}"/>`;
    }
  }
  svg.innerHTML = rects;
}

function setupDrift() {
  const svgs = $$("[data-drift]");
  const draw = () => svgs.forEach(drawDrift);
  draw();
  let timer = 0;
  window.addEventListener("resize", () => {
    clearTimeout(timer);
    timer = setTimeout(draw, 150);
  });
}

// ------------------------------------------------------------------ install

function installCommand() {
  const { protocol, hostname, origin } = window.location;
  const hosted = protocol === "https:" && hostname !== "localhost" && !hostname.startsWith("127.");
  return `curl -fsSL ${hosted ? `${origin}/install` : RAW_INSTALL} | bash`;
}

function setupInstall() {
  const command = installCommand();
  for (const node of $$("[data-install-cmd]")) node.textContent = command;
  for (const button of $$("[data-copy-install]")) {
    button.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(command);
      } catch {
        const range = document.createRange();
        range.selectNodeContents($("[data-install-cmd]"));
        getSelection().removeAllRanges();
        getSelection().addRange(range);
        return;
      }
      button.classList.add("is-done");
      const label = $("span", button);
      const before = label?.textContent;
      if (label) label.textContent = "Copied";
      setTimeout(() => {
        button.classList.remove("is-done");
        if (label) label.textContent = before;
      }, 1600);
    });
  }
}

// ------------------------------------------------------------------ see it

function setupCarousel() {
  const root = $("[data-carousel]");
  if (!root) return;
  const track = $(".slides", root);
  const slides = $$(".slide", root);
  const bar = $("[data-progress]");
  let index = 0;
  const show = (next) => {
    index = (next + slides.length) % slides.length;
    track.style.transform = `translateX(${-index * 100}%)`;
    if (bar) bar.style.transform = `translateX(${index * 100}%)`;
    slides.forEach((slide, i) => slide.setAttribute("aria-hidden", String(i !== index)));
  };
  for (const button of $$("[data-slide]")) button.addEventListener("click", () => show(index + Number(button.dataset.slide)));
  let startX = null;
  track.addEventListener("pointerdown", (event) => (startX = event.clientX));
  track.addEventListener("pointerup", (event) => {
    if (startX !== null && Math.abs(event.clientX - startX) > 40) show(index + (event.clientX < startX ? 1 : -1));
    startX = null;
  });
  show(0);
}

// ------------------------------------------------------------------ small things

function setupReveal() {
  const items = $$(".reveal");
  if (reduceMotion || !("IntersectionObserver" in window)) {
    items.forEach((item) => item.classList.add("is-visible"));
    return;
  }
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        entry.target.classList.add("is-visible");
        observer.unobserve(entry.target);
      }
    },
    { threshold: 0.12, rootMargin: "0px 0px -40px 0px" },
  );
  // Siblings arrive one after another.
  const groups = new Map();
  for (const item of items) {
    const siblings = groups.get(item.parentElement) ?? [];
    siblings.push(item);
    groups.set(item.parentElement, siblings);
  }
  for (const siblings of groups.values()) siblings.forEach((item, index) => item.style.setProperty("--delay", `${Math.min(index, 6) * 70}ms`));
  items.forEach((item) => observer.observe(item));
}

async function setupStars() {
  const label = $("[data-stars]");
  if (!label) return;
  try {
    const response = await fetch(`https://api.github.com/repos/${REPO}`, { headers: { Accept: "application/vnd.github+json" } });
    if (!response.ok) return;
    const { stargazers_count: stars } = await response.json();
    if (typeof stars === "number" && stars > 0) label.textContent = `★ ${stars.toLocaleString()}`;
  } catch {
    /* offline or rate-limited: the icon alone stays */
  }
}

setupThemes();
setupDrift();
setupInstall();
setupCarousel();
setupReveal();
void setupStars();
