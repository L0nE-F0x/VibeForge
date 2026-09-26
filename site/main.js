// VibeForge site. No framework, no tracking. Themes are the palettes VibeForge itself derives
// from Omarchy's theme files (generated with src/core/theme.ts); pick one from the bar, or press
// T to flip through them.

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
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let currentTheme = THEMES[0].id;

/** Calls back when an element scrolls into view (true) or out of it (false). */
function watch(element, callback, threshold = 0.15) {
  if (!element) return;
  if (!("IntersectionObserver" in window)) {
    callback(true);
    return;
  }
  new IntersectionObserver(([entry]) => callback(entry.isIntersecting), { threshold }).observe(element);
}

/** A small deterministic random source, so the circuit and the pixels look the same on every visit. */
function seeded(seed) {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return ((state >>> 0) % 100000) / 100000;
  };
}

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

/** Text on the accent gradient: the theme's darkest colour or white, whichever reads better on both stops. */
function onAccent(theme) {
  const score = (text) => Math.min(contrast(text, theme.accent), contrast(text, theme.accent2));
  return score(theme.bgDeep) >= score("#ffffff") ? theme.bgDeep : "#ffffff";
}

function dots(theme) {
  return `<span class="dots"><i style="background:${theme.bg}"></i><i style="background:${theme.accent}"></i><i style="background:${theme.accent2}"></i></span>`;
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
  for (const key of ["red", "green", "yellow", "blue", "cyan", "magenta"]) set(`--${key}`, theme[key]);
  root.dataset.mode = theme.mode;
  $('meta[name="theme-color"]')?.setAttribute("content", theme.bg);
  for (const label of $$("[data-theme-name]")) label.textContent = theme.name;
  for (const option of $$("[data-theme-id]")) {
    const on = option.dataset.themeId === theme.id;
    if (option.classList.contains("theme-option")) option.setAttribute("aria-checked", String(on));
    else option.setAttribute("aria-pressed", String(on));
  }
  const swatches = $("[data-swatches]");
  if (swatches) {
    swatches.innerHTML = [theme.bg, theme.bgRaised, theme.accent, theme.accent2, theme.red, theme.green, theme.cyan, theme.magenta]
      .map((color) => `<span style="background:${color}" title="${color}"></span>`)
      .join("");
  }
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
  const pills = $("[data-theme-pills]");
  for (const theme of THEMES) {
    const option = document.createElement("button");
    option.type = "button";
    option.className = "theme-option";
    option.setAttribute("role", "menuitemradio");
    option.dataset.themeId = theme.id;
    option.innerHTML = `<span>${theme.name}</span>${theme.mode === "light" ? '<span class="mode">light</span>' : ""}${dots(theme)}`;
    option.addEventListener("click", () => applyTheme(theme.id));
    list?.append(option);

    const pill = document.createElement("button");
    pill.type = "button";
    pill.className = "theme-pill";
    pill.dataset.themeId = theme.id;
    pill.innerHTML = `${dots(theme)}<span>${theme.name}</span>`;
    pill.addEventListener("click", () => applyTheme(theme.id));
    pills?.append(pill);
  }

  const menu = $("[data-theme-menu]");
  const button = $("[data-theme-open]");
  const close = () => {
    if (!menu || menu.hidden) return;
    menu.hidden = true;
    button?.setAttribute("aria-expanded", "false");
  };
  button?.addEventListener("click", (event) => {
    event.stopPropagation();
    menu.hidden = !menu.hidden;
    button.setAttribute("aria-expanded", String(!menu.hidden));
  });
  document.addEventListener("click", (event) => {
    if (menu && !menu.hidden && !menu.contains(event.target)) close();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") close();
    const typing = event.target instanceof HTMLElement && event.target.closest("input, textarea, [contenteditable]");
    if (typing || event.ctrlKey || event.metaKey || event.altKey) return;
    // Omarchy's own theme picker lives on Super+Ctrl+Shift+Space; a plain T will do here.
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

/** The install terminal prints its output once, line by line, the first time it comes into view. */
function setupInstallWindow() {
  const win = $("[data-install-window]");
  if (!win || reduceMotion) return;
  const lines = $$(".iw-ln", win);
  const pauses = [0, 500, 120, 260, 420, 900, 1100, 700, 380, 240, 200, 160];
  win.classList.add("is-typing");
  let started = false;
  watch(
    win,
    async (visible) => {
      if (!visible || started) return;
      started = true;
      for (const [index, line] of lines.entries()) {
        await sleep(pauses[index] ?? 200);
        line.classList.add("is-shown");
      }
      await sleep(400);
      win.classList.remove("is-typing");
    },
    0.35,
  );
}

// ------------------------------------------------------------------ the forge and its circuit
// The wordmark's plate is a chip: traces leave its sides as parallel buses, bend at 45° the way
// PCB traces do, and fall down the margins beside the copy, with light running out along them.
// Short legs line its top and bottom. Drawn in real pixels around where the plate and the text
// actually are, so the middle stays readable at every window size; on narrow screens the buses
// simply run off the edges.

/** How far the hero's copy reaches from the centre line, in the circuit's coordinates. */
function copyReach(center, boxLeft) {
  let reach = 0;
  for (const element of $$(".hero-copy > :not(.forge)")) {
    let rect = element.getBoundingClientRect();
    if (element.matches("h1, .lede")) {
      const range = document.createRange();
      range.selectNodeContents(element);
      rect = range.getBoundingClientRect();
    }
    if (!rect.width) continue;
    reach = Math.max(reach, Math.abs(rect.left - boxLeft - center), Math.abs(rect.right - boxLeft - center));
  }
  return reach;
}

function drawCircuit(svg) {
  const forge = $("[data-forge]");
  if (!svg || !forge) return;
  const box = svg.getBoundingClientRect();
  const plate = forge.getBoundingClientRect();
  const width = Math.round(box.width);
  const height = Math.round(box.height);
  const left = Math.round(plate.left - box.left);
  const top = Math.round(plate.top - box.top);
  const right = Math.round(plate.right - box.left);
  const bottom = Math.round(plate.bottom - box.top);
  const center = (left + right) / 2;
  const ns = "http://www.w3.org/2000/svg";
  const random = seeded(11);
  const round = Math.round;
  const make = (tag, attrs) => {
    const node = document.createElementNS(ns, tag);
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
    return node;
  };
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);

  const traces = []; // { d, end: [x, y] | null }
  const pins = [];
  const vias = [];
  const pitch = 11;
  const clear = copyReach(center, 0) + 34;
  const room = width / 2 - clear;
  const wide = room >= 90;

  // The side buses. The top leg runs furthest, so the lines stay parallel and never cross.
  const legs = 5;
  for (const side of [-1, 1]) {
    const edge = side < 0 ? left : right;
    const buses = [];
    for (let k = 0; k < legs; k += 1) {
      const y = round(top + ((k + 1) * (bottom - top)) / (legs + 1));
      pins.push({ x: edge, y, dx: side * 7, dy: 0 });
      buses.push({ k, x: edge, y, d: `M${edge} ${y}` });
    }
    const outward = (distance) => (bus) => {
      bus.x += side * distance;
      bus.d += ` H${bus.x}`;
    };
    const step = (size) => (bus) => {
      bus.x += side * size;
      bus.y += size;
      bus.d += ` L${bus.x} ${bus.y}`;
    };

    if (!wide) {
      // Out to the window's edge, stepping down once on the way.
      const jog = round(12 + random() * 14);
      const start = round(18 + random() * 30);
      for (const bus of buses) {
        outward(start + (legs - 1 - bus.k) * pitch)(bus);
        step(jog)(bus);
        bus.x = side < 0 ? -20 : width + 20;
        bus.d += ` H${bus.x}`;
        traces.push({ d: bus.d, end: null });
      }
      continue;
    }

    // Across to the margin, a 45° step, then down it; now and then the whole bus steps outward.
    const drop = round(18 + random() * 16);
    const across = Math.max(10, round(clear + 6 - (right - left) / 2 - drop));
    for (const bus of buses) {
      outward(across + (legs - 1 - bus.k) * pitch)(bus);
      step(drop)(bus);
    }
    let budget = room - (legs - 1) * pitch - 30 - drop;
    let y = Math.max(...buses.map((bus) => bus.y));
    const floor = height * 0.9;
    const ends = buses.map((bus) => round(floor - (bus.k * 0.6 + random()) * 110));
    while (y < floor) {
      y += round(60 + random() * 150);
      const jog = budget > 24 && random() < 0.7 ? round(12 + random() * Math.min(60, budget - 12)) : 0;
      for (const bus of buses) {
        if (bus.done) continue;
        // Inner legs step later than outer ones, which keeps the bus parallel.
        const at = y + bus.k * pitch;
        if (at >= ends[bus.k]) {
          bus.d += ` V${ends[bus.k]}`;
          bus.y = ends[bus.k];
          bus.done = true;
          continue;
        }
        bus.d += ` V${at}`;
        bus.y = at;
        if (jog) {
          step(jog)(bus);
          if (random() < 0.12) vias.push({ x: bus.x, y: bus.y });
        }
      }
      budget -= jog;
      if (buses.every((bus) => bus.done)) break;
    }
    for (const bus of buses) {
      if (!bus.done) {
        bus.d += ` V${ends[bus.k]}`;
        bus.y = ends[bus.k];
      }
      traces.push({ d: bus.d, end: [bus.x, bus.y] });
    }
  }

  // Along the top, legs rise and spread under the bar and run off the edges.
  const topLegs = 3;
  for (const side of [-1, 1]) {
    for (let m = 0; m < topLegs; m += 1) {
      let x = round(center + side * ((right - left) / 2 - 26 - m * 22));
      let y = top;
      pins.push({ x, y, dx: 0, dy: -7 });
      let d = `M${x} ${y}`;
      // Inner legs rise higher, so no leg crosses another on its way out.
      y = top - 14 - m * pitch;
      if (y < 6) continue;
      d += ` V${y}`;
      x = side < 0 ? -20 : width + 20;
      d += ` H${x}`;
      traces.push({ d, end: null });
    }
  }

  // Along the bottom, short legs ending in pads, clear of the copy and of the version label.
  const part = $(".part", forge)?.getBoundingClientRect();
  const feet = Math.max(4, Math.floor((right - left - 60) / 22));
  const first = center - ((feet - 1) * 22) / 2;
  for (let index = 0; index < feet; index += 1) {
    const x = round(first + index * 22);
    if (part && x > part.left - box.left - 10 && x < part.right - box.left + 10) continue;
    pins.push({ x, y: bottom, dx: 0, dy: 7 });
    if (random() < 0.45) {
      const y = bottom + round(12 + random() * 12);
      traces.push({ d: `M${x} ${bottom} V${y}`, end: [x, y], short: true });
    }
  }

  const parts = [];
  for (const trace of traces) parts.push(make("path", { d: trace.d, class: "trace" }));
  for (const via of vias) parts.push(make("rect", { x: via.x - 2.5, y: via.y - 2.5, width: 5, height: 5, class: "via" }));
  for (const trace of traces) {
    if (trace.end) parts.push(make("rect", { x: trace.end[0] - 3, y: trace.end[1] - 3, width: 6, height: 6, class: "node" }));
  }
  for (const pin of pins) parts.push(make("line", { x1: pin.x, y1: pin.y, x2: pin.x + pin.dx, y2: pin.y + pin.dy, class: "pin" }));
  if (!reduceMotion) {
    for (const trace of traces) {
      if (trace.short || random() < 0.1) continue;
      const pulse = make("path", { d: trace.d, class: "pulse" });
      pulse.dataset.speed = (0.16 + random() * 0.14).toFixed(3);
      pulse.dataset.dash = (40 + random() * 70).toFixed(0);
      pulse.dataset.offset = random().toFixed(3);
      parts.push(pulse);
    }
  }
  svg.replaceChildren(...parts);

  // Each pulse runs the real length of its trace, then waits a beat before the next one.
  for (const pulse of svg.querySelectorAll(".pulse")) {
    const length = pulse.getTotalLength();
    const dash = Number(pulse.dataset.dash);
    const period = length + dash + 500;
    const duration = period / (Number(pulse.dataset.speed) * 1000);
    pulse.setAttribute("stroke-dasharray", `${dash} ${period - dash}`);
    pulse.style.setProperty("--travel", `${-period}`);
    pulse.style.setProperty("--dur", `${duration.toFixed(2)}s`);
    pulse.style.setProperty("--delay", `${(-Number(pulse.dataset.offset) * duration).toFixed(2)}s`);
  }
}

function setupCircuit() {
  const svg = $("[data-circuit]");
  if (!svg) return;
  drawCircuit(svg);
  document.fonts?.ready.then(() => drawCircuit(svg));
  // Redraw when the width changes; phones resize the height as the address bar slides.
  let lastWidth = window.innerWidth;
  let timer = 0;
  window.addEventListener("resize", () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (window.innerWidth === lastWidth) return;
      lastWidth = window.innerWidth;
      drawCircuit(svg);
    }, 150);
  });
}

// ------------------------------------------------------------------ the desk demo

const SESSION = [
  { html: '<span class="dim">~/Projects/frontier-halls</span>' },
  { type: '<span class="acc">❯</span> claude "# VibeForge run · Agent: Release notes · Allowed folders: ~/Projects/frontier-halls …"' },
  { html: '<span class="dim">  brief · memory · 2 skills · prompt — handed over as one argument</span>', wait: 700 },
  { html: "" },
  { html: '<span class="acc">●</span> Reading the 14 commits merged since yesterday', wait: 900 },
  { html: '<span class="acc">●</span> Grouping changes by what a player can now do', wait: 900 },
  { html: '<span class="acc">●</span> Checking every claim against the diff', wait: 1000 },
  { html: '<span class="acc">●</span> Wrote RELEASE_NOTES.md  <span class="grn">+38</span> <span class="red">−4</span>', wait: 900 },
  { html: "" },
  { html: '<span class="grn">✓</span> Draft ready for review. Nothing pushed, tagged or published.', wait: 600 },
];

function setupDesk() {
  const desk = $(".desk");
  const term = $("[data-demo-term]");
  if (!desk || !term) return;
  const bar = $("[data-demo-sessionbar]");
  const toast = $("[data-demo-toast]");
  const badge = $("[data-demo-badge]");
  const reviewCount = $("[data-demo-review]");
  const live = $("[data-demo-live]");
  const newRun = $("[data-demo-newrun]");
  const windows = $$("[data-win]", desk);
  const barLive = bar?.innerHTML ?? "";
  let visible = false;
  let generation = 0;

  const focus = (index) => windows.forEach((win, i) => win.classList.toggle("is-focused", i === index));

  // Lines are appended, never redrawn, so each fades in once.
  const addLine = (html) => {
    const line = document.createElement("div");
    line.className = "ln";
    line.innerHTML = html || "&nbsp;";
    term.append(line);
    return line;
  };

  async function play() {
    const mine = ++generation;
    const alive = () => mine === generation;
    focus(0);
    if (bar) {
      bar.classList.remove("is-done");
      bar.innerHTML = barLive;
    }
    toast?.classList.remove("is-shown");
    newRun?.classList.add("is-hidden");
    newRun?.classList.remove("is-arriving");
    if (badge) badge.textContent = "2";
    if (reviewCount) reviewCount.textContent = "2";
    if (live) live.textContent = "1 live";
    term.replaceChildren();
    await sleep(700);
    for (const step of SESSION) {
      if (!alive()) return;
      if (step.type) {
        const text = step.type;
        const prefix = text.slice(0, text.indexOf("</span>") + 7);
        const body = text.slice(prefix.length);
        const line = addLine(prefix);
        for (let index = 0; index <= body.length; index += 2) {
          if (!alive()) return;
          line.innerHTML = `${prefix}${body.slice(0, index)}<span class="caret"></span>`;
          await sleep(16);
        }
        line.innerHTML = `${prefix}${body}`;
      } else {
        addLine(step.html);
      }
      await sleep(step.wait ?? 250);
    }
    if (!alive()) return;
    addLine('<span class="acc">❯</span> <span class="caret"></span>');
    await sleep(900);
    if (!alive()) return;
    if (bar) {
      bar.classList.add("is-done");
      bar.innerHTML = '<span class="m-dot is-ok"></span><span>Finished · 1 file changed, 38 insertions(+) · review it in Runs</span><span class="m-ghost-btn"><svg><use href="#i-rotate-ccw"/></svg>Continue</span>';
    }
    if (live) live.textContent = "Idle";
    toast?.classList.add("is-shown");
    if (newRun) {
      newRun.classList.remove("is-hidden");
      newRun.classList.add("is-arriving");
    }
    if (reviewCount) reviewCount.textContent = "3";
    if (badge) {
      badge.textContent = "3";
      badge.classList.add("bump");
      setTimeout(() => badge.classList.remove("bump"), 300);
    }
    await sleep(1400);
    if (!alive()) return;
    focus(1);
    await sleep(2600);
    if (!alive()) return;
    toast?.classList.remove("is-shown");
    focus(2);
    await sleep(2000);
    if (!alive()) return;
    focus(0);
    await sleep(900);
    if (alive() && visible) void play();
  }

  if (reduceMotion) {
    for (const step of SESSION) addLine(step.html ?? step.type);
    return;
  }

  watch(desk, (now) => {
    const was = visible;
    visible = now;
    if (visible && !was) void play();
    if (!visible) generation += 1;
  });
}

// ------------------------------------------------------------------ small motions

/** Swaps a line of text on a timer with a little roll, while it's on screen. */
function flipper(slot, values, interval, onChange) {
  if (!slot || reduceMotion) return;
  let index = 0;
  let visible = false;
  watch(slot, (now) => (visible = now), 0);
  setInterval(() => {
    if (!visible) return;
    index = (index + 1) % values.length;
    slot.classList.add("out");
    setTimeout(() => {
      slot.textContent = values[index];
      onChange?.(index);
      slot.classList.remove("out");
      slot.classList.add("in");
      requestAnimationFrame(() => requestAnimationFrame(() => slot.classList.remove("in")));
    }, 380);
  }, interval);
}

function setupFlips() {
  flipper($("[data-engine-flip]"), ["Claude Code", "Codex", "Grok Build", "Gemini CLI", "OpenCode"], 2400);

  // "3 runs to review", as the app says it in each of its languages.
  const codes = $$("[data-lang-codes] span");
  const lines = ["3 runs to review", "3 Läufe zu prüfen", "3 ejecuciones por revisar", "3 exécutions à relire", "3 execuções para revisar", "レビュー待ちの実行が 3 件", "3 次运行待审阅"];
  const mark = (index) => codes.forEach((code, i) => code.classList.toggle("is-on", i === index));
  mark(0);
  flipper($("[data-lang-line]"), lines, 2200, mark);
}

/** The update sheet plays the in-app update: notes, the installer's steps, then Restart. */
function setupUpdateArt() {
  const art = $("[data-update-art]");
  if (!art || reduceMotion) return;
  const steps = [1800, 700, 1100, 900, 700, 3200];
  let visible = false;
  let running = false;
  art.dataset.step = "0";
  const run = async () => {
    running = true;
    while (visible) {
      for (const [step, pause] of steps.entries()) {
        art.dataset.step = String(step);
        await sleep(pause);
      }
    }
    running = false;
  };
  watch(art, (now) => {
    visible = now;
    if (visible && !running) void run();
  });
}

/** The voice card plays a dictation: the meter moves with the speech, the words arrive, then it starts again. */
function setupVoiceArt() {
  const art = $("[data-voice-art]");
  if (!art || reduceMotion) return;
  const cells = $$("[data-voice-meter] i");
  const typed = $("[data-voice-typed]");
  const clock = $("[data-voice-clock]");
  const lines = ["Atlas, add tests for the scheduler.", "Forge, new task: fix the login page.", "Refactor the lamp so it glows at night.", "Forge, send."];
  let visible = false;
  let running = false;
  const level = (value) => {
    const lit = Math.round(value * cells.length);
    cells.forEach((cell, i) => {
      cell.classList.toggle("on", i < lit && i < cells.length - 3);
      cell.classList.toggle("hot", i < lit && i >= cells.length - 3);
    });
  };
  const run = async () => {
    running = true;
    let n = 0;
    while (visible) {
      const line = lines[n % lines.length];
      n += 1;
      typed.textContent = "";
      const started = Date.now();
      // Speaking: the meter dances for a couple of seconds.
      while (visible && Date.now() - started < 2200) {
        level(0.35 + Math.random() * 0.6);
        clock.textContent = `0:0${Math.floor((Date.now() - started) / 1000)}`;
        await sleep(90);
      }
      level(0);
      // Then the words arrive, a few at a time, as whisper hands them back.
      for (const word of line.split(" ")) {
        if (!visible) break;
        typed.textContent += (typed.textContent ? " " : "") + word;
        await sleep(70);
      }
      await sleep(2400);
    }
    running = false;
  };
  watch(art, (now) => {
    visible = now;
    if (visible && !running) void run();
  });
}

function setupGlow() {
  for (const card of $$("[data-glow]")) {
    card.addEventListener("pointermove", (event) => {
      const rect = card.getBoundingClientRect();
      card.style.setProperty("--mx", `${event.clientX - rect.left}px`);
      card.style.setProperty("--my", `${event.clientY - rect.top}px`);
    });
  }
}

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

/** Loops that nobody can see stand still. */
function setupPausing() {
  for (const element of $$(".hero, .final, .bento, .flow")) watch(element, (visible) => element.classList.toggle("is-paused", !visible), 0);
}

// ------------------------------------------------------------------ tour

const CAPTIONS = [
  ["Home", "What's live, what finished and needs a look, and what runs next."],
  ["Code", "Shells and CLIs tiled side by side, a file tree, and a browser dock for your dev server."],
  ["Tasks", "Writing a task starts nothing. Execute does, and the result lands in Review with its diff."],
];

function setupTour() {
  const root = $("[data-tour]");
  if (!root) return;
  const tabs = $$("[data-shot]", root);
  const shots = $$(".shot", root);
  const caption = $("[data-tour-caption]", root);
  let index = 0;

  const show = (next) => {
    index = (next + shots.length) % shots.length;
    tabs.forEach((tab, i) => tab.setAttribute("aria-selected", String(i === index)));
    shots.forEach((shot, i) => {
      shot.classList.toggle("is-on", i === index);
      shot.setAttribute("aria-hidden", String(i !== index));
    });
    const [title, text] = CAPTIONS[index];
    if (caption) caption.innerHTML = `<b>${title}</b>${text}`;
  };

  // Each tab's bar fills while its screenshot is up; when it's full, the next one takes over.
  // The bar pauses with the rest of the page's loops when the tour is off screen.
  if (!reduceMotion) {
    root.classList.add("is-playing");
    for (const tab of tabs) $("i", tab)?.addEventListener("animationend", () => root.classList.contains("is-playing") && show(index + 1));
    watch(root, (visible) => root.classList.toggle("is-paused", !visible), 0.3);
  }
  for (const tab of tabs) {
    tab.addEventListener("click", () => {
      root.classList.remove("is-playing");
      show(Number(tab.dataset.shot));
    });
  }
  let startX = null;
  const frame = $(".tour-frame", root);
  frame?.addEventListener("pointerdown", (event) => (startX = event.clientX));
  frame?.addEventListener("pointerup", (event) => {
    if (startX !== null && Math.abs(event.clientX - startX) > 40) {
      root.classList.remove("is-playing");
      show(index + (event.clientX < startX ? 1 : -1));
    }
    startX = null;
  });
  show(0);
}

// ------------------------------------------------------------------ the final forge
// Loose pixels along the floor, as around the 0.4.0 wordmark, and embers rising off them.

function drawDrift(svg) {
  const cell = 16;
  const size = 10;
  const { width, height } = svg.getBoundingClientRect();
  const cols = Math.ceil(width / cell);
  const rows = Math.ceil(height / cell);
  const random = seeded(29);
  let rects = "";
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const side = Math.min(x, cols - 1 - x) / (cols / 2);
      const low = y / Math.max(1, rows - 1);
      // Thick along the floor and up the far edges, clear in the middle where the text is.
      const band = Math.min(180, width * 0.12);
      const sides = Math.max(1 - (Math.min(x, cols - 1 - x) * cell) / band, 0) * 0.7 * low;
      const floor = Math.max(0, (low - 0.72) / 0.28) * (0.3 + (1 - side) * 0.7);
      const chance = Math.min(0.8, Math.max(0, sides + floor - 0.16) ** 1.4);
      const roll = random();
      const strength = random();
      if (roll < chance) rects += `<rect x="${x * cell}" y="${y * cell}" width="${size}" height="${size}" opacity="${(0.1 + strength * 0.5).toFixed(2)}"/>`;
    }
  }
  svg.innerHTML = rects;
}

function makeEmbers(box, section) {
  if (!box || !section || reduceMotion) return;
  const random = seeded(5);
  const height = section.offsetHeight;
  const count = window.innerWidth < 700 ? 22 : 40;
  const embers = [];
  for (let index = 0; index < count; index += 1) {
    const ember = document.createElement("span");
    ember.className = "ember";
    const duration = 7 + random() * 8;
    const style = ember.style;
    style.setProperty("--x", `${(random() * 100).toFixed(2)}%`);
    style.setProperty("--s", `${2 + Math.floor(random() * 4)}px`);
    style.setProperty("--c", random() < 0.55 ? "var(--accent)" : "var(--accent-2)");
    style.setProperty("--d", `${duration.toFixed(2)}s`);
    style.setProperty("--delay", `${(-random() * duration).toFixed(2)}s`);
    style.setProperty("--dx", `${((random() - 0.5) * 90).toFixed(0)}px`);
    style.setProperty("--h", `${(height * (0.45 + random() * 0.5)).toFixed(0)}px`);
    style.setProperty("--o", (0.45 + random() * 0.55).toFixed(2));
    embers.push(ember);
  }
  box.replaceChildren(...embers);
}

function setupFinal() {
  const section = $("[data-final]");
  const drift = $("[data-drift]");
  const embers = $("[data-embers]");
  const draw = () => {
    if (drift) drawDrift(drift);
    makeEmbers(embers, section);
  };
  draw();
  let lastWidth = window.innerWidth;
  let timer = 0;
  window.addEventListener("resize", () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (window.innerWidth === lastWidth) return;
      lastWidth = window.innerWidth;
      draw();
    }, 150);
  });
}

// ------------------------------------------------------------------ waybar

function setupWaybar() {
  const links = $$("[data-ws]");
  const sections = links.map((link) => document.getElementById(link.dataset.ws)).filter(Boolean);
  const mark = (id) => links.forEach((link) => link.setAttribute("aria-current", String(link.dataset.ws === id)));
  if ("IntersectionObserver" in window) {
    const observer = new IntersectionObserver(
      (entries) => {
        const visibleNow = entries.filter((entry) => entry.isIntersecting).sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
        if (visibleNow) mark(visibleNow.target.id);
      },
      { threshold: [0, 0.2, 0.5], rootMargin: "-30% 0px -50% 0px" },
    );
    sections.forEach((section) => observer.observe(section));
  }

  // Omarchy's waybar clock: the weekday and the time.
  const clock = $("[data-clock]");
  const tick = () => {
    if (!clock) return;
    const now = new Date();
    const day = now.toLocaleDateString(undefined, { weekday: "long" });
    const time = now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
    clock.textContent = `${day} ${time}`;
  };
  tick();
  setInterval(tick, 15_000);
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

// ------------------------------------------------------------------ go

setupThemes();
setupInstall();
setupCircuit();
setupReveal();
setupDesk();
setupFlips();
setupUpdateArt();
setupVoiceArt();
setupGlow();
setupTour();
setupFinal();
setupInstallWindow();
setupWaybar();
setupPausing();
void setupStars();
