// VibeForge site. No framework, no tracking. Themes are the palettes VibeForge itself derives
// from Omarchy's theme files (generated with src/core/theme.ts).

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

function buildThemeControls() {
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

    const mini = $("[data-mini-swatches]");
    if (mini) {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.dataset.themeId = theme.id;
      chip.title = theme.name;
      chip.setAttribute("aria-label", `Use ${theme.name}`);
      chip.innerHTML = [theme.bg, theme.accent, theme.accent2].map((color) => `<span style="background:${color}"></span>`).join("");
      chip.addEventListener("click", () => applyTheme(theme.id));
      mini.append(chip);
    }

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
    menu.hidden = true;
    button.setAttribute("aria-expanded", "false");
  };
  button?.addEventListener("click", (event) => {
    event.stopPropagation();
    menu.hidden = !menu.hidden;
    button.setAttribute("aria-expanded", String(!menu.hidden));
  });
  document.addEventListener("click", (event) => {
    if (!menu.hidden && !menu.contains(event.target)) close();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") close();
    // Omarchy's own theme picker lives on Super+Ctrl+Shift+Space; a plain "t" will do here.
    if (event.key === "t" && !event.ctrlKey && !event.metaKey && !event.altKey && !/input|textarea/i.test(document.activeElement?.tagName ?? "")) {
      const index = THEMES.findIndex((theme) => theme.id === currentTheme);
      applyTheme(THEMES[(index + 1) % THEMES.length].id);
    }
  });

  let saved = null;
  try {
    saved = localStorage.getItem("vibeforge.theme");
  } catch {
    saved = null;
  }
  applyTheme(saved ?? THEMES[0].id, { save: false });
}

// ------------------------------------------------------------------ install command

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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function setupDesk() {
  const term = $("[data-demo-term]");
  if (!term) return;
  const bar = $("[data-demo-sessionbar]");
  const toast = $("[data-demo-toast]");
  const badge = $("[data-demo-badge]");
  const reviewCount = $("[data-demo-review]");
  const live = $("[data-demo-live]");
  const newRun = $("[data-demo-newrun]");
  const windows = $$("[data-win]");
  const barLive = bar?.innerHTML ?? "";
  let visible = true;
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
    if (badge) badge.textContent = "2";
    if (reviewCount) reviewCount.textContent = "2";
    if (live) live.textContent = "1 live";
    term.replaceChildren();
    await sleep(600);
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

  const observer = new IntersectionObserver(
    ([entry]) => {
      const was = visible;
      visible = entry.isIntersecting;
      if (visible && !was) void play();
      if (!visible) generation += 1;
    },
    { threshold: 0.15 },
  );
  visible = false;
  observer.observe($(".desk"));
}

// ------------------------------------------------------------------ small motions

function setupEngineFlip() {
  const slot = $("[data-engine-flip]");
  if (!slot || reduceMotion) return;
  const names = ["Claude Code", "Codex", "Grok Build", "Gemini CLI", "OpenCode"];
  let index = 0;
  setInterval(() => {
    index = (index + 1) % names.length;
    slot.classList.add("out");
    setTimeout(() => {
      slot.textContent = names[index];
      slot.classList.remove("out");
      slot.classList.add("in");
      requestAnimationFrame(() => requestAnimationFrame(() => slot.classList.remove("in")));
    }, 380);
  }, 2400);
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

function setupWaybar() {
  const links = $$("[data-ws]").filter((link) => link.getAttribute("href").startsWith("#"));
  const sections = links.map((link) => document.getElementById(link.dataset.ws)).filter(Boolean);
  const mark = (id) => links.forEach((link) => link.setAttribute("aria-current", String(link.dataset.ws === id)));
  const observer = new IntersectionObserver(
    (entries) => {
      const visibleNow = entries.filter((entry) => entry.isIntersecting).sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
      if (visibleNow) mark(visibleNow.target.id);
    },
    { threshold: [0.2, 0.5], rootMargin: "-20% 0px -40% 0px" },
  );
  sections.forEach((section) => observer.observe(section));

  const clock = $("[data-clock]");
  const tick = () => {
    if (clock) clock.textContent = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
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
    /* offline, rate-limited: the plain label stays */
  }
}

// ------------------------------------------------------------------ circuit backdrop
// Traces fall from a glowing core that hangs just below the top bar, like the Apex Forge
// wallpaper. Drawn in real pixels for the current window so the core never slips under the bar.

function drawCircuit(svg) {
  const box = svg.getBoundingClientRect();
  const width = Math.round(box.width) || window.innerWidth;
  const height = Math.round(box.height) || window.innerHeight;
  const bar = $(".bar")?.getBoundingClientRect();
  const ns = "http://www.w3.org/2000/svg";
  let seed = 7;
  const random = () => {
    seed = (seed * 16807) % 2147483647;
    return (seed - 1) / 2147483646;
  };
  const make = (tag, attrs) => {
    const node = document.createElementNS(ns, tag);
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
    return node;
  };

  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  const coreW = 128;
  const coreH = 58;
  const coreX = width / 2;
  const coreTop = Math.round((bar?.bottom ?? 48) + 18);
  const parts = [
    make("rect", { x: coreX - coreW / 2, y: coreTop, width: coreW, height: coreH, rx: 12, class: "core" }),
    make("use", { href: "#i-logo", x: coreX - 17, y: coreTop + coreH / 2 - 17, width: 34, height: 34, class: "core-mark" }),
  ];

  const spread = Math.min(1.25, Math.max(0.35, width / 1600));
  const drop = Math.max(0.7, height / 900);
  for (let index = 0; index < 34; index += 1) {
    const side = index % 2 === 0 ? -1 : 1;
    let x = coreX + side * (10 + random() * (coreW / 2 - 16));
    let y = coreTop + coreH;
    let d = `M${x.toFixed(0)} ${y}`;
    const reach = (120 + random() * 700) * spread;
    const steps = 3 + Math.floor(random() * 4);
    for (let step = 0; step < steps; step += 1) {
      y += (40 + random() * 150) * drop;
      d += ` V${y.toFixed(0)}`;
      x += side * (30 + random() * (reach / steps)) * spread;
      y += (20 + random() * 30) * drop;
      d += ` L${x.toFixed(0)} ${y.toFixed(0)}`;
    }
    y += (60 + random() * 200) * drop;
    d += ` V${y.toFixed(0)}`;
    parts.push(make("path", { d, class: "trace" }));
    parts.push(make("circle", { cx: x.toFixed(0), cy: y.toFixed(0), r: 2.6, class: "node" }));
    if (!reduceMotion && random() > 0.3) {
      const pulse = make("path", { d, class: "pulse" });
      pulse.dataset.speed = (0.16 + random() * 0.14).toFixed(3);
      pulse.dataset.dash = (40 + random() * 60).toFixed(0);
      pulse.dataset.offset = random().toFixed(3);
      parts.push(pulse);
    }
  }
  svg.replaceChildren(...parts);

  // Each pulse runs the real length of its trace, then waits a beat before the next one.
  for (const pulse of svg.querySelectorAll(".pulse")) {
    const length = pulse.getTotalLength();
    const dash = Number(pulse.dataset.dash);
    const period = length + dash + 600;
    const duration = period / (Number(pulse.dataset.speed) * 1000);
    pulse.setAttribute("stroke-dasharray", `${dash} ${period - dash}`);
    pulse.style.setProperty("--travel", `${-period}`);
    pulse.style.setProperty("--dur", `${duration.toFixed(2)}s`);
    pulse.style.setProperty("--delay", `${(-Number(pulse.dataset.offset) * duration).toFixed(2)}s`);
  }
}

function setupCircuit() {
  const svg = $("#circuit");
  if (!svg) return;
  drawCircuit(svg);
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

// ------------------------------------------------------------------ go

buildThemeControls();
setupInstall();
setupCircuit();
setupReveal();
setupDesk();
setupEngineFlip();
setupGlow();
setupWaybar();
void setupStars();
