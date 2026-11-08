const TOKEN_KEY = "vibeforge-phone";
const PLANS_KEY = "vibeforge-plans-open";
const RUNS_KEY = "vibeforge-runs-open";
const INSTALL_KEY = "vibeforge-install-dismissed";
/** Chosen on the landing page. Absent buzz keeps an already-allowed notification. Absent tuck keeps finished work closed. */
const BUZZ_KEY = "vibeforge-buzz";
const TUCK_KEY = "vibeforge-tuck-finished";
const TEXT_KEY = "vibeforge-large-text";
/** The same page the desk and the website credit. */
const APEXFORGE = "https://ame-apexforge.org/";
const app = document.querySelector("#app");

let token = localStorage.getItem(TOKEN_KEY) || "";
/** A paired phone opens here. Enter reaches the desk; the name on the desk comes back. */
let view = token ? "home" : "pair";
if (localStorage.getItem(TEXT_KEY) === "1") document.documentElement.classList.add("large");
let desk = null;
let session = null;
let sessionQuery = { ptyId: "", runId: "" };
/** Where a session's Back goes: the desk, or the Orchestrator it was opened from. */
let sessionBack = "desk";
let launchWorkspace = "";
let error = "";
let busy = false;
let known = new Map();
let primed = false;
let timer = 0;
let ticket = 0;
/** The poll: one at a time, the next two seconds after the last one ends, slower while the computer doesn't answer. */
const POLL_MS = 2000;
const POLL_SLOWEST_MS = 16_000;
/** A poll that takes longer gives up, so a stalled link shows as offline instead of a page that stops. */
const POLL_TIMEOUT_MS = 15_000;
let polling = false;
let pollAgain = false;
let pollFailures = 0;
/** The page's words in the phone's language, from the app's own catalogs (GET /api/text). */
let words = {};
let language = "en";
let plans = null;
let plansAt = 0;
const PLANS_EVERY_MS = 60_000;
const PLAN_NAMES = { claude: "Claude", codex: "Codex", grok: "Grok", agy: "Gemini", kimi: "Kimi", muse: "Muse" };
/** The desktop's plan marks (`PLAN_MARKS` in src/shared/pixel.ts). One colour, eleven pixels square. */
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
/** The nodes of the page on show that a poll updates in place. Inputs are never rebuilt by a poll. */
let parts = {};

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value == null || value === false) continue;
    if (key === "class") node.className = value;
    else if (key.startsWith("on") && typeof value === "function") node.addEventListener(key.slice(2).toLowerCase(), value);
    else node.setAttribute(key, String(value));
  }
  for (const child of children.flat()) {
    if (child == null || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

function t(key, vars) {
  const text = words[key] || key;
  return vars ? text.replace(/\{(\w+)\}/g, (match, name) => (name in vars ? String(vars[name]) : match)) : text;
}

function unit(value, name) {
  return new Intl.NumberFormat(language, { style: "unit", unit: name, unitDisplay: "narrow" }).format(value);
}

/** How long, the way the desktop's plan limits say it: "45m", "3h 20m", "2d 4h". */
function span(ms) {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 60) return unit(minutes, "minute");
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return minutes % 60 ? `${unit(hours, "hour")} ${unit(minutes % 60, "minute")}` : unit(hours, "hour");
  return hours % 24 ? `${unit(Math.floor(hours / 24), "day")} ${unit(hours % 24, "hour")}` : unit(hours / 24, "day");
}

function ago(iso) {
  if (!iso) return "";
  const seconds = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (!Number.isFinite(seconds)) return "";
  if (seconds < 60) return t("plans.justNow");
  if (seconds < 3600) return unit(Math.floor(seconds / 60), "minute");
  if (seconds < 86400) return unit(Math.floor(seconds / 3600), "hour");
  return unit(Math.floor(seconds / 86400), "day");
}

function stateLabel(state) {
  if (state === "working") return t("phone.working");
  if (state === "waiting") return t("phone.waiting");
  return t("phone.finished");
}

/** The words for the phone's language. Before they arrive (or if they can't), keys stand in. */
async function loadWords() {
  try {
    const body = await (await fetch("/api/text")).json();
    words = body.words || {};
    language = body.language || "en";
    document.documentElement.lang = language;
  } catch {
    words = { "phone.offline": "The computer is not serving the page." };
  }
}

async function call(path, options = {}) {
  const headers = { ...(options.body ? { "Content-Type": "application/json" } : {}) };
  if (token) headers.Authorization = `Bearer ${token}`;
  // A poll gives up after `timeout`; what a person tapped waits for its answer.
  const abort = options.timeout ? new AbortController() : null;
  const limit = abort ? window.setTimeout(() => abort.abort(), options.timeout) : 0;
  let response;
  let body;
  try {
    response = await fetch(path, { method: options.method || "GET", headers, body: options.body, signal: abort?.signal });
    body = await response.json().catch(() => {
      if (abort?.signal.aborted) throw new Error("timed out");
      return {};
    });
  } catch {
    throw Object.assign(new Error(t("phone.offline")), { offline: true });
  } finally {
    window.clearTimeout(limit);
  }
  if (response.status === 401 && path !== "/api/pair") {
    forget();
    throw new Error(body.error || t("phone.pairLead"));
  }
  if (!response.ok) throw Object.assign(new Error(body.error || t("phone.error.failed")), { working: body.working === true });
  return body;
}

function post(path, body) {
  return call(path, { method: "POST", body: JSON.stringify(body) });
}

function forget() {
  token = "";
  localStorage.removeItem(TOKEN_KEY);
  desk = null;
  session = null;
  window.clearTimeout(timer);
  timer = 0;
  if (view !== "pair") {
    view = "pair";
    show();
  }
}

async function buzz(body, data) {
  if (!buzzWanted()) return;
  if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
  const note = { body, tag: data.key, renotify: true, data };
  try {
    const ready = navigator.serviceWorker && (await navigator.serviceWorker.ready);
    if (ready) await ready.showNotification("VibeForge", note);
    else new Notification("VibeForge", note);
  } catch {
    /* a missed buzz is not a failed send */
  }
}

function watch(payload) {
  const next = new Map();
  for (const workspace of payload.workspaces) {
    for (const item of workspace.sessions) {
      const key = item.runId || item.ptyId;
      if (!key) continue;
      next.set(key, item);
      const previous = known.get(key);
      if (!primed || !previous || previous.state === item.state) continue;
      if (item.state === "waiting" && previous.state === "working") void buzz(t("phone.buzzWaiting", { name: item.title }), { key, ptyId: item.ptyId || "", runId: item.runId || "" });
      if (item.state === "done") void buzz(`${t("phone.buzzFinished", { name: item.title })}${item.changes ? ` · ${item.changes}` : ""}`, { key, ptyId: "", runId: item.runId || "" });
    }
  }
  if (primed) {
    for (const [key, previous] of known) {
      if (next.has(key) || previous.state === "done") continue;
      void buzz(t("phone.buzzFinished", { name: previous.title }), { key, ptyId: "", runId: previous.runId || "" });
    }
  }
  known = next;
  primed = true;
}

/**
 * Polls now, and the next poll follows when this one is done. One already on its way is not overtaken:
 * on a slow link, polls every two seconds regardless dropped each other and the page stopped changing.
 */
async function refresh() {
  if (!token || view === "pair") return;
  if (polling) {
    pollAgain = true;
    return;
  }
  polling = true;
  window.clearTimeout(timer);
  timer = 0;
  try {
    await poll();
  } finally {
    polling = false;
    if (pollAgain) {
      pollAgain = false;
      void refresh();
    } else schedule(Math.min(POLL_SLOWEST_MS, POLL_MS * 2 ** pollFailures));
  }
}

async function poll() {
  const mine = ++ticket;
  const shown = view;
  const timeout = POLL_TIMEOUT_MS;
  try {
    const payload = await call("/api/desk", { timeout });
    // A change of page has already replaced what this one would show: the next poll asks for that page.
    if (mine !== ticket) return;
    // Plan limits move slowly, and reading them may ask the providers: once a minute is plenty.
    if (Date.now() - plansAt > PLANS_EVERY_MS) {
      plansAt = Date.now();
      plans = (await call("/api/plans", { timeout }).catch(() => ({ plans }))).plans ?? null;
    }
    const next = view === "session" ? await call(`/api/session?ptyId=${encodeURIComponent(sessionQuery.ptyId)}&runId=${encodeURIComponent(sessionQuery.runId)}`, { timeout }) : null;
    const nextOrch = view === "maestro" ? await call("/api/orchestrator", { timeout }) : null;
    if (mine !== ticket) return;
    watch(payload);
    desk = payload;
    if (view === "session") session = next;
    if (view === "maestro") orch = nextOrch;
    error = "";
    pollFailures = 0;
  } catch (err) {
    if (mine !== ticket) return;
    error = err.message;
    pollFailures += 1;
  }
  if (view !== shown) show();
  else update();
}

function schedule(delay = POLL_MS) {
  window.clearTimeout(timer);
  timer = 0;
  if (!token) return;
  timer = window.setTimeout(() => void refresh(), delay);
}

/** Runs one action with the buttons held. Returns what the action returned, or false when it failed. */
async function withBusy(task) {
  const shown = view;
  busy = true;
  error = "";
  update();
  let result = false;
  try {
    result = await task();
  } catch (err) {
    error = err.message;
  }
  busy = false;
  if (view !== shown) show();
  else update();
  void refresh();
  return result;
}

// ---------------------------------------------------------------- pages

/** Builds the page for the current view from scratch. Only a change of view does this. */
function show() {
  ticket += 1;
  // The mic belongs to the Orchestrator's box: leaving the page puts it down.
  if (view !== "maestro") micCancel();
  // The install offer only shows on the code and the landing page (app.css), never over a text box.
  document.body.dataset.view = token ? view : "pair";
  parts = { banner: el("div", { class: "banner", hidden: true }) };
  app.replaceChildren(parts.banner, page(), credit());
  update();
}

/** Brings the page on show up to date without touching what is being typed. */
function update() {
  parts.banner.hidden = !error;
  parts.banner.textContent = error;
  if (view === "desk") updateDesk();
  else if (view === "launch") updateLaunch();
  else if (view === "session") updateSession();
  else if (view === "maestro") updateMaestro();
  else if (view === "pair" && parts.pair) parts.pair.disabled = busy;
}

function setView(next) {
  view = next;
  show();
  void refresh();
}

function page() {
  if (view === "pair" || !token) return pairPage();
  if (view === "home") return homePage();
  if (view === "launch") return launchPage();
  if (view === "session") return sessionPage();
  if (view === "maestro") return maestroPage();
  return deskPage();
}

function pairPage() {
  const input = el("input", {
    id: "code",
    autocapitalize: "off",
    autocorrect: "off",
    spellcheck: "false",
    placeholder: "vf_…",
    onkeydown: (event) => {
      if (event.key === "Enter") void pair(input.value);
    },
  });
  parts.pair = el("button", { class: "btn", type: "button", onclick: () => void pair(input.value) }, t("phone.continue"));
  return el(
    "section",
    {},
    el("div", { class: "brand" }, wordmark(), el("h1", {}, "VibeForge")),
    el("p", { class: "muted lede" }, t("phone.pairLead")),
    el("div", { class: "card stack" }, el("label", {}, t("phone.code"), input), parts.pair),
  );
}

async function pair(code) {
  const given = code.trim();
  busy = true;
  error = "";
  update();
  try {
    const response = await fetch("/api/pair", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: given }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || t("phone.codeWrong"));
    token = given;
    localStorage.setItem(TOKEN_KEY, token);
    busy = false;
    primed = false;
    known = new Map();
    setView("home");
  } catch (err) {
    error = err.message;
    busy = false;
    update();
  }
}

/** Off is stored. No choice buzzes only when the phone already allowed it, so an existing buzz keeps going. */
function buzzWanted() {
  const saved = localStorage.getItem(BUZZ_KEY);
  if (saved === "0") return false;
  if (saved === "1") return true;
  return typeof Notification !== "undefined" && Notification.permission === "granted";
}

function buzzShownOn() {
  return buzzWanted() && typeof Notification !== "undefined" && Notification.permission === "granted";
}

function textLarge() {
  return localStorage.getItem(TEXT_KEY) === "1";
}

/** Finished-only projects start closed, unless the landing page said to leave them open. */
function tuckFinished() {
  return localStorage.getItem(TUCK_KEY) !== "0";
}

function paintSwitch(button, on) {
  button.classList.toggle("on", on);
  button.setAttribute("aria-checked", on ? "true" : "false");
}

function prefSwitch(label, hint, on, change) {
  const button = el(
    "button",
    {
      class: on ? "switch on" : "switch",
      type: "button",
      role: "switch",
      "aria-checked": on ? "true" : "false",
    },
    el("span", { class: "copy" }, el("span", { class: "label" }, label), hint ? el("span", { class: "hint" }, hint) : null),
    el("span", { class: "knob", "aria-hidden": "true" }),
  );
  button.addEventListener("click", () => {
    const next = button.getAttribute("aria-checked") !== "true";
    void change(next, button);
  });
  return button;
}

let askingBuzz = false;

async function onBuzz(want, button) {
  if (askingBuzz) return;
  if (!want) {
    localStorage.setItem(BUZZ_KEY, "0");
    paintSwitch(button, false);
    return;
  }
  if (typeof Notification === "undefined") return;
  askingBuzz = true;
  try {
    let permission = Notification.permission;
    if (permission === "default") permission = await Notification.requestPermission();
    const granted = permission === "granted";
    localStorage.setItem(BUZZ_KEY, granted ? "1" : "0");
    paintSwitch(button, granted);
    if (parts.buzzNote) parts.buzzNote.hidden = permission !== "denied";
  } finally {
    askingBuzz = false;
  }
}

/** A panel over the landing. Closing it shows the three buttons again; the page is not rebuilt. */
function sheet(title, ...nodes) {
  let opener = null;
  /** What the panel covers: the page under it, while it is open. */
  const under = (inert) => {
    for (const child of panel.parentElement?.children || []) {
      if (child !== panel && !child.classList.contains("sheet")) child.toggleAttribute("inert", inert);
    }
  };
  const close = () => {
    panel.hidden = true;
    under(false);
    if (opener instanceof HTMLElement) opener.focus();
    opener = null;
  };
  const panel = el(
    "div",
    { class: "sheet", hidden: true, role: "dialog", "aria-modal": "true", "aria-label": title },
    el("div", { class: "top sheet-bar" }, el("button", { class: "back sheet-close", type: "button", onclick: close }, t("phone.homeClose")), el("h2", {}, title)),
    el("div", { class: "sheet-body" }, ...nodes),
  );
  panel.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || panel.hidden) return;
    event.preventDefault();
    close();
  });
  panel.open = () => {
    opener = document.activeElement;
    const home = panel.parentElement;
    for (const other of home?.querySelectorAll(":scope > .sheet") || []) {
      if (other !== panel) other.hidden = true;
    }
    under(true);
    panel.hidden = false;
    panel.querySelector(".sheet-close")?.focus();
  };
  return panel;
}

function homePage() {
  const blocked = typeof Notification !== "undefined" && Notification.permission === "denied";
  parts.buzzNote = el("p", { class: "small faint home-note", hidden: !blocked }, t("phone.homeBuzzBlocked"));
  const how = sheet(
    t("phone.homeHowTitle"),
    el("p", { class: "muted lede" }, t("phone.homeLead")),
    el("p", { class: "how" }, t("phone.homeHow")),
    el("p", { class: "how" }, t("phone.homeHowMaestro")),
    el("p", { class: "small muted reach" }, t("phone.homeReach")),
    el("p", { class: "small faint home-return" }, t("phone.homeReturn")),
  );
  const settings = sheet(
    t("phone.homeSettings"),
    el(
      "article",
      { class: "card home-settings" },
      prefSwitch(t("phone.homeBuzz"), t("phone.homeBuzzHint"), buzzShownOn(), onBuzz),
      parts.buzzNote,
      prefSwitch(t("phone.homePlans"), t("phone.homePlansHint"), plansOpen(), (on, button) => {
        localStorage.setItem(PLANS_KEY, on ? "1" : "0");
        paintSwitch(button, on);
      }),
      prefSwitch(t("phone.homeTuck"), t("phone.homeTuckHint"), tuckFinished(), (on, button) => {
        localStorage.setItem(TUCK_KEY, on ? "1" : "0");
        paintSwitch(button, on);
      }),
      prefSwitch(t("phone.homeText"), "", textLarge(), (on, button) => {
        localStorage.setItem(TEXT_KEY, on ? "1" : "0");
        document.documentElement.classList.toggle("large", on);
        paintSwitch(button, on);
      }),
    ),
  );
  return el(
    "section",
    { class: "home" },
    el(
      "div",
      { class: "home-hero" },
      el("div", { class: "brand" }, wordmark(), el("h1", {}, "VibeForge")),
      el("p", { class: "home-kind" }, t("phone.homeKind")),
      el("p", { class: "muted home-blurb" }, t("phone.homeBlurb")),
      el(
        "div",
        { class: "home-actions" },
        el("button", { class: "ghost home-action", type: "button", onclick: () => how.open() }, t("phone.homeHowTitle")),
        el("button", { class: "ghost home-action", type: "button", onclick: () => settings.open() }, t("phone.homeSettings")),
        el("button", { class: "btn home-enter", type: "button", onclick: () => setView("desk") }, t("phone.homeEnter")),
      ),
    ),
    how,
    settings,
  );
}

/** The mark and the name, as one button back to the landing page. */
function deskWordmark() {
  return el(
    "button",
    { class: "wordmark-home", type: "button", "aria-label": t("phone.homeMark"), onclick: () => setView("home") },
    brandMark(),
    wordmark(),
  );
}

function deskPage() {
  parts.buzz = el(
    "button",
    { class: "ghost", type: "button", hidden: true, onclick: () => void Notification.requestPermission().then(() => update()) },
    t("phone.buzz"),
  );
  parts.plans = el("div", {});
  parts.plansKey = null;
  parts.list = el("div", {});
  parts.listKey = null;
  const maestro = el("button", { class: "ghost maestro-open", type: "button", onclick: () => setView("maestro") }, t("rail.orchestrator"));
  return el(
    "section",
    {},
    el("div", { class: "top brand-top" }, deskWordmark(), parts.buzz, maestro),
    parts.plans,
    parts.list,
  );
}

function updateDesk() {
  const ask = typeof Notification !== "undefined" && Notification.permission === "default" && localStorage.getItem(BUZZ_KEY) !== "0";
  parts.buzz.hidden = !ask;
  const plansKey = JSON.stringify([plans, Math.floor(Date.now() / 60000)]);
  if (plansKey !== parts.plansKey) {
    parts.plansKey = plansKey;
    parts.plans.replaceChildren(...(plans?.providers?.length ? [plansCard(plans)] : []));
  }
  if (!desk) return;
  // The list has no inputs, so it is redrawn whole, but only when something on it changed (or a minute passed).
  const key = JSON.stringify([desk.workspaces, Math.floor(Date.now() / 60000)]);
  if (key === parts.listKey) return;
  parts.listKey = key;
  parts.list.replaceChildren(
    ...(desk.workspaces.length ? desk.workspaces.map((workspace) => workspaceCard(workspace)) : [el("div", { class: "card muted" }, t("phone.noWorkspaces"))]),
  );
}

function readRuns() {
  try {
    const value = JSON.parse(localStorage.getItem(RUNS_KEY) || "{}");
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

/** A workspace with someone working or waiting starts open. One that is only finished starts hidden. A saved Show or Hide wins, and the landing page can leave finished work open. */
function runsAreOpen(workspace) {
  const saved = readRuns()[workspace.id || "elsewhere"];
  if (saved === "0") return false;
  if (saved === "1") return true;
  if (!tuckFinished()) return true;
  return workspace.sessions.some((item) => item.state === "working" || item.state === "waiting");
}

function workspaceCard(workspace) {
  const key = workspace.id || "elsewhere";
  const hasSessions = workspace.sessions.length > 0;
  const open = !hasSessions || runsAreOpen(workspace);
  const start = workspace.id ? el("button", { class: "ghost", type: "button", onclick: () => openLaunch(workspace.id) }, t("phone.start")) : null;
  const toggle = hasSessions
    ? el(
        "button",
        {
          class: "ghost runs-toggle",
          type: "button",
          "aria-expanded": String(open),
          onclick: () => {
            const next = toggle.getAttribute("aria-expanded") !== "true";
            const saved = readRuns();
            saved[key] = next ? "1" : "0";
            localStorage.setItem(RUNS_KEY, JSON.stringify(saved));
            toggle.closest(".workspace")?.classList.toggle("collapsed", !next);
            toggle.textContent = next ? t("phone.plansHide") : t("phone.plansShow");
            toggle.setAttribute("aria-expanded", String(next));
          },
        },
        open ? t("phone.plansHide") : t("phone.plansShow"),
      )
    : null;
  return el(
    "article",
    { class: hasSessions && !open ? "card workspace collapsed" : "card workspace" },
    el(
      "div",
      { class: "row" },
      el("div", { class: "grow" }, el("div", { class: "title" }, workspace.id ? workspace.name : t("phone.elsewhere")), workspace.folder ? el("div", { class: "small faint" }, workspace.folder) : null),
      toggle,
      start,
    ),
    hasSessions ? workspace.sessions.map((item) => sessionButton(item)) : el("p", { class: "small faint" }, t("phone.nothingRunning")),
  );
}

function sessionButton(item) {
  return el(
    "button",
    {
      class: `session ${item.state}`,
      type: "button",
      onclick: () => openSession({ ptyId: item.ptyId || "", runId: item.runId || "" }),
    },
    el("div", { class: "row" }, el("span", { class: `px ${item.state}`, "aria-hidden": "true" }), el("div", { class: "grow title" }, item.title), el("span", { class: `pill ${item.state}` }, stateLabel(item.state))),
    el("div", { class: "small muted" }, [item.detail, ago(item.endedAt || item.startedAt), item.changes].filter(Boolean).join(" · ")),
    item.alsoHere?.length ? el("div", { class: "small faint" }, t("phone.alsoHere", { names: item.alsoHere.join(", ") })) : null,
  );
}

function level(percent) {
  if (percent === null || percent === undefined || percent < 80) return "quiet";
  return percent < 100 ? "warm" : "full";
}

/** Which of four shades a row gets, lightest at the top (`shade` in src/shared/pixel.ts). */
function shade(y, height) {
  const at = height <= 1 ? 0 : y / (height - 1);
  return at <= 0.2 ? 0 : at < 0.45 ? 1 : at < 0.75 ? 2 : 3;
}

/** Pixel art from rows of "#", `scale` screen pixels per cell. Shaded art takes the brand's four bands; plain art takes one colour. */
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

function planMark(id) {
  const rows = PLAN_MARKS[id];
  return rows ? pixels(rows, "plan-mark", 2) : null;
}

function brandMark() {
  return pixels(MARK, "pixels mark", 2, true);
}

/** "VIBEFORGE" in the seven-row pixel font, one blank column between letters (`wordmark` in src/shared/pixel.ts). */
function wordmark(label) {
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

/** "Created by ApexForge", the same credit as the desk and the website. */
function credit() {
  const [before, after = ""] = t("phone.credit").split("{name}");
  return el(
    "p",
    { class: "credit" },
    before,
    el("a", { href: APEXFORGE, target: "_blank", rel: "noopener noreferrer" }, "ApexForge"),
    after,
  );
}

function bar(percent, className) {
  const fill = el("i");
  // CSSOM, not a style attribute: the page's CSP has no 'unsafe-inline'.
  fill.style.width = `${Math.max(0, Math.min(100, percent))}%`;
  return el("span", { class: className }, fill);
}

function plansOpen() {
  return localStorage.getItem(PLANS_KEY) === "1";
}

/** Plan limits, as the desktop's live popover shows them: each plan's busiest window first. Closed until opened. */
function plansCard(summary) {
  const now = Date.now();
  const open = plansOpen();
  const toggle = el(
    "button",
    {
      class: "ghost plans-toggle",
      type: "button",
      "aria-expanded": String(open),
      onclick: () => {
        const next = !plansOpen();
        localStorage.setItem(PLANS_KEY, next ? "1" : "0");
        const card = toggle.closest(".plans");
        if (card) card.classList.toggle("collapsed", !next);
        toggle.textContent = next ? t("phone.plansHide") : t("phone.plansShow");
        toggle.setAttribute("aria-expanded", String(next));
      },
    },
    open ? t("phone.plansHide") : t("phone.plansShow"),
  );
  return el(
    "article",
    { class: open ? "card plans" : "card plans collapsed" },
    el("div", { class: "row plans-head" }, el("div", { class: "grow title" }, t("plans.title")), toggle),
    summary.providers.map((provider) => {
      const name = PLAN_NAMES[provider.id] || provider.id;
      let sub;
      if (provider.problem) sub = t(`plans.problem.${provider.problem}`, { cli: name });
      else if (provider.percent === null) sub = t("plans.asking");
      else {
        const parts = [];
        if (provider.resetsAt && Date.parse(provider.resetsAt) > now) parts.push(t("plans.resetsIn", { time: span(Date.parse(provider.resetsAt) - now) }));
        if (provider.fullAt) parts.push(t("plans.fullIn", { time: span(Date.parse(provider.fullAt) - now) }));
        sub = parts.join(" · ");
      }
      // One window that is the headline number already says everything.
      const only = provider.windows.length === 1 && provider.windows[0].name === provider.limiter && provider.windows[0].percent === provider.percent;
      const rows = only ? [] : provider.windows;
      const credits = provider.credits > 0
        ? t("plans.credits", { amount: new Intl.NumberFormat(language, { style: "currency", currency: "USD" }).format(provider.credits) })
        : "";
      return el(
        "div",
        { class: `plan ${level(provider.percent)}${provider.problem ? " stale" : ""}` },
        el(
          "div",
          { class: "row" },
          planMark(provider.id),
          el("span", { class: "grow title" }, name, provider.limiter && rows.length ? el("span", { class: "faint" }, ` · ${provider.limiter}`) : null),
          el("b", { class: provider.percent === null ? "plan-pct none" : "plan-pct" }, provider.percent === null ? "—" : `${Math.round(provider.percent)}%`),
        ),
        provider.percent === null ? null : bar(provider.percent, "plan-bar"),
        sub ? el("div", { class: "small muted" }, sub) : null,
        rows.map((window) =>
          el("div", { class: `plan-window ${level(window.percent)}` }, el("span", { class: "small" }, window.name), bar(window.percent, "plan-track"), el("span", { class: "small" }, `${Math.round(window.percent)}%`)),
        ),
        credits ? el("div", { class: "small faint" }, credits) : null,
      );
    }),
  );
}

function openSession(query) {
  sessionQuery = query;
  session = null;
  sessionBack = view === "maestro" ? "maestro" : "desk";
  setView(query.ptyId || query.runId ? "session" : sessionBack);
}

function openLaunch(workspaceId) {
  launchWorkspace = workspaceId;
  setView("launch");
}

/** Agents allowed in the workspace, then each CLI on its own. Values are "agent:<id>" or "engine:<id>". */
function launchChoices() {
  const agents = (desk?.agents ?? []).filter((agent) => agent.workspaceIds.includes(launchWorkspace));
  const engines = desk?.engines ?? [];
  return { agents, engines };
}

function launchPage() {
  const workspace = (desk?.workspaces ?? []).find((item) => item.id === launchWorkspace);
  const { agents, engines } = launchChoices();
  const back = el("button", { class: "back", type: "button", onclick: () => setView("desk") }, t("phone.back"));
  const top = el("div", { class: "top" }, back, el("h1", {}, workspace?.name || t("phone.start")));
  if (!agents.length && !engines.length) {
    return el("section", {}, top, el("div", { class: "card muted" }, t("phone.nobodyHere")));
  }
  const select = el(
    "select",
    { id: "who" },
    agents.length ? el("optgroup", { label: t("phone.agents") }, agents.map((agent) => el("option", { value: `agent:${agent.id}` }, `${agent.name}${agent.engine ? ` · ${agent.engine}` : ""}`))) : null,
    engines.length ? el("optgroup", { label: t("phone.clis") }, engines.map((engine) => el("option", { value: `engine:${engine.id}` }, engine.label))) : null,
  );
  const prompt = el("textarea", { id: "prompt", placeholder: t("phone.firstPromptHint") });
  parts.start = el("button", { class: "btn", type: "button", onclick: () => void startAgent(select.value, prompt) }, t("phone.start"));
  return el(
    "section",
    { class: "fit" },
    top,
    agents.length ? null : el("p", { class: "small faint" }, t("phone.cliOnly")),
    el("div", { class: "card stack composer" }, el("label", {}, t("phone.who"), select), el("label", {}, t("phone.firstPrompt"), prompt), parts.start),
  );
}

function updateLaunch() {
  if (!parts.start) return;
  parts.start.disabled = busy;
  parts.start.textContent = busy ? t("phone.starting") : t("phone.start");
}

async function startAgent(choice, box) {
  const [kind, id] = [choice.slice(0, choice.indexOf(":")), choice.slice(choice.indexOf(":") + 1)];
  if (!id) return;
  const result = await withBusy(() =>
    post("/api/launch", {
      workspaceId: launchWorkspace,
      agentId: kind === "agent" ? id : "",
      engineId: kind === "engine" ? id : "",
      prompt: box.value,
    }),
  );
  if (result) openSession({ ptyId: result.ptyId || "", runId: result.runId || "" });
}

function sessionPage() {
  parts.title = el("h1", { class: "grow" }, t("phone.session"));
  parts.px = el("span", { class: "px", hidden: true, "aria-hidden": "true" });
  parts.pill = el("span", { class: "pill", hidden: true });
  parts.meta = el("p", { class: "small muted", hidden: true });
  parts.screen = el("pre", { class: "screen" }, t("phone.loading"));
  parts.stick = true;
  parts.prompt = el("textarea", { id: "prompt", placeholder: t("phone.next") });
  parts.send = el("button", { class: "btn", type: "button", onclick: () => void sendText(parts.prompt.value) }, t("phone.send"));
  parts.stop = el("button", { class: "ghost", type: "button", hidden: true, onclick: () => void stopSession() }, t("phone.stop"));
  // Follow the end of the screen unless the person scrolled up to read.
  parts.screen.addEventListener("scroll", () => {
    const pre = parts.screen;
    parts.stick = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 24;
  });
  return el(
    "section",
    { class: "fit" },
    el("div", { class: "top" }, el("button", { class: "back", type: "button", onclick: () => { session = null; setView(sessionBack); } }, t("phone.back")), parts.title, parts.px, parts.pill),
    parts.meta,
    parts.screen,
    el("div", { class: "card stack composer" }, parts.prompt, el("div", { class: "actions" }, parts.send, parts.stop)),
  );
}

function updateSession() {
  parts.send.disabled = busy || !session?.canSend;
  parts.send.textContent = busy ? t("phone.sending") : t("phone.send");
  if (!session) return;
  parts.title.textContent = session.title;
  parts.px.hidden = false;
  parts.px.className = `px ${session.state}`;
  parts.pill.hidden = false;
  parts.pill.className = `pill ${session.state}`;
  parts.pill.textContent = stateLabel(session.state);
  parts.screen.className = `screen ${session.state}`;
  const meta = [session.detail, session.changes].filter(Boolean).join(" · ");
  parts.meta.hidden = !meta;
  parts.meta.textContent = meta;
  parts.prompt.placeholder = session.state === "done" ? t("phone.nextDone") : t("phone.next");
  parts.stop.hidden = !session.stop;
  parts.stop.disabled = busy;
  parts.stop.textContent = session.stop === "interrupt" ? t("phone.interrupt") : t("phone.stop");
  const screen = session.screen || t("phone.emptyScreen");
  if (parts.screen.textContent !== screen) {
    parts.screen.textContent = screen;
    if (parts.stick) parts.screen.scrollTop = parts.screen.scrollHeight;
  }
}

/** Sends the next instruction, and clears the box once it has gone through. */
async function sendText(text) {
  const words = text.trim();
  if (!words || !session) return;
  let force = false;
  if (session.state === "working") {
    if (!window.confirm(t("phone.sendAnyway"))) return;
    force = true;
  }
  const query = { ptyId: session.ptyId || "", runId: session.runId || "" };
  const sent = await withBusy(async () => {
    let result;
    try {
      result = await post("/api/send", { ...query, text: words, force });
    } catch (err) {
      // It started working again between the last look and the send.
      if (!err.working) throw err;
      if (!window.confirm(t("phone.sendAnyway"))) return false;
      result = await post("/api/send", { ...query, text: words, force: true });
    }
    sessionQuery = { ptyId: result.ptyId || "", runId: result.runId || query.runId };
    parts.stick = true;
    return true;
  });
  if (sent && parts.prompt) parts.prompt.value = "";
}

async function stopSession() {
  if (!session?.ptyId) return;
  const ask = session.stop === "interrupt" ? t("phone.askInterrupt") : t("phone.askStop");
  if (!window.confirm(ask)) return;
  const ptyId = session.ptyId;
  await withBusy(() => post("/api/stop", { ptyId }));
}

// ---------------------------------------------------------------- the Orchestrator (Maestro)

// The desktop's Orchestrator view on the phone (src/ui/views/Orchestrator.tsx): the same
// conversation, plan cards and Running list, read from and sent to the computer. The planning CLI
// runs there; the page only shows what it said and passes on what the person says and taps.

/** The Orchestrator as the page last read it (GET /api/orchestrator). */
let orch = null;
/** What is typed or dictated for the Orchestrator, kept while the page shows something else. */
let orchDraft = "";
/** A step's changes on their way to the computer, by step id, so a poll in between doesn't put the old words back. */
const pendingSteps = new Map();
/** Step changes go one after another, and Go waits for them. */
let stepQueue = Promise.resolve();

const ISSUE_KEYS = { workspace: "orch.issue.workspace", engine: "orch.issue.engine", engineMissing: "orch.issue.engineMissing", target: "orch.issue.target", prompt: "orch.issue.prompt" };
const PLAN_TONE = { waiting: "waiting", running: "working", done: "done", cancelled: "done", replaced: "done" };

/** Pixel glyphs in one colour (the text's): a step's kind and state, a branch, leaving a step out, the mic. */
const GLYPHS_SMALL = {
  start: ["#......", "###....", "#####..", "#######", "#####..", "###....", "#......"],
  tell: [".......", "#..#...", ".#..#..", "..#..#.", ".#..#..", "#..#...", "......."],
  stop: [".......", ".#####.", ".#####.", ".#####.", ".#####.", ".#####.", "......."],
  done: [".......", "......#", ".....#.", "#...#..", ".#.#...", "..#....", "......."],
  failed: ["...#...", "...#...", "...#...", "...#...", "...#...", ".......", "...#..."],
  remove: ["#.....#", ".#...#.", "..#.#..", "...#...", "..#.#..", ".#...#.", "#.....#"],
  branch: [".#...#.", ".#...#.", ".#..#..", ".#.#...", ".##....", ".#.....", ".#....."],
  mic: ["..###..", ".#####.", ".#####.", ".#####.", ".#####.", "#.###.#", "#.....#", ".#...#.", "..###..", "...#...", ".#####."],
};

function glyph(name, scale = 2) {
  return pixels(GLYPHS_SMALL[name], `glyph glyph-${name}`, scale);
}

/** A sentence with a number in it, in the plural form the phone's language uses (translateCount on the desktop). */
function tCount(base, count, vars) {
  const form = `${base}.${new Intl.PluralRules(language).select(count)}`;
  return t(form in words ? form : `${base}.other`, { count, ...vars });
}

function engineLabel(id) {
  return orch?.engines.find((engine) => engine.id === id)?.label || id || "";
}

/** The node someone is typing in. A poll leaves it alone; a picked option is already sent, so a list doesn't count. */
function editingIn(node) {
  const active = document.activeElement;
  return Boolean(active && node.contains(active) && active.matches("input, textarea"));
}

function maestroPage() {
  parts.orchTurns = new Map();
  parts.orchTurnsKey = null;
  parts.planner = el("select", { class: "orch-planner", "aria-label": t("orch.planner"), onchange: () => void saveOrch({ engine: parts.planner.value }) });
  parts.plannerKey = null;
  parts.modes = ["plan", "go"].map((mode) => el("button", { class: "seg", type: "button", "data-mode": mode, "aria-pressed": "false", onclick: () => void saveOrch({ mode }) }, t(`orch.mode.${mode}`)));
  parts.newTalk = el("button", { class: "ghost top-action", type: "button", title: t("orch.newTip"), onclick: () => void newTalk() }, t("orch.new"));
  parts.runningOpen = el("button", { class: "ghost orch-running-open", type: "button", hidden: true, onclick: () => parts.runningSheet.open() });
  parts.runningList = el("div", { class: "orch-team" });
  parts.runningKey = null;
  parts.runningSheet = sheet(t("orch.team"), parts.runningList);
  parts.orchLoading = el("p", { class: "small faint" }, t("phone.loading"));
  parts.earlier = el("p", { class: "small faint orch-earlier", hidden: true });
  parts.startBody = el("p", { class: "muted" });
  parts.startHere = el(
    "div",
    { class: "orch-start", hidden: true },
    el("h2", {}, t("orch.empty.title")),
    parts.startBody,
  );
  parts.notReady = el("div", { class: "orch-problem", hidden: true });
  parts.turnList = el("div", { class: "orch-list" });
  parts.thinkingText = el("span", { class: "grow muted" });
  parts.thinkingStop = el("button", { class: "ghost small-btn", type: "button", onclick: () => void stopThinking() }, t("orch.stop"));
  parts.thinking = el("div", { class: "orch-turn from-vibeforge orch-thinking", hidden: true }, whoMark(), el("span", { class: "px working", "aria-hidden": "true" }), parts.thinkingText, parts.thinkingStop);
  parts.turns = el("div", { class: "orch-turns" }, parts.orchLoading, parts.earlier, parts.startHere, parts.notReady, parts.turnList, parts.thinking);
  parts.stickTurns = true;
  // Follow the conversation as it grows, unless the person scrolled up to read.
  parts.turns.addEventListener("scroll", () => {
    const node = parts.turns;
    parts.stickTurns = node.scrollHeight - node.scrollTop - node.clientHeight < 32;
  });
  parts.box = el("textarea", { id: "orch-say", placeholder: t("phone.orchPlaceholder"), "aria-label": t("orch.title") });
  parts.box.value = orchDraft;
  parts.box.addEventListener("input", () => {
    orchDraft = parts.box.value;
  });
  parts.micMeter = el("span", { class: "meter", "aria-hidden": "true" }, Array.from({ length: METER_CELLS }, () => el("i")));
  parts.micBusy = el("span", { class: "px working", "aria-hidden": "true" });
  parts.micWord = el("strong", {});
  parts.micClock = el("span", { class: "mic-clock" });
  parts.micHint = el("span", { class: "small faint mic-hint" });
  parts.micCancel = el("button", { class: "ghost small-btn mic-cancel", type: "button", onclick: () => micCancel() }, t("common.cancel"));
  parts.micNote = el("div", { class: "mic-note", hidden: true, role: "status", "aria-live": "polite" }, parts.micMeter, parts.micBusy, parts.micWord, parts.micClock, parts.micHint, parts.micCancel);
  parts.mic = micButton();
  parts.say = el("button", { class: "btn", type: "button", onclick: () => void askOrch() }, t("phone.send"));
  return el(
    "section",
    { class: "fit orch" },
    el("div", { class: "top" }, el("button", { class: "back", type: "button", onclick: () => setView("desk") }, t("phone.back")), el("h1", { class: "grow" }, t("orch.title")), parts.newTalk),
    el(
      "div",
      { class: "orch-head" },
      el("label", { class: "orch-planner-field" }, t("orch.planner"), parts.planner),
      el("div", { class: "segs", role: "group", "aria-label": t("orch.modeLabel") }, parts.modes),
    ),
    parts.runningOpen,
    parts.turns,
    el("div", { class: "card stack composer orch-composer" }, parts.micNote, parts.box, el("div", { class: "actions" }, parts.mic, parts.say)),
    parts.runningSheet,
  );
}

function whoMark() {
  return el("span", { class: "orch-who", "aria-hidden": "true" }, brandMark());
}

function updateMaestro() {
  if (!parts.turns) return;
  paintPlanner();
  for (const button of parts.modes) {
    const on = orch?.mode === button.dataset.mode;
    button.classList.toggle("on", on);
    button.setAttribute("aria-pressed", String(on));
    button.disabled = busy || !orch;
  }
  parts.newTalk.disabled = busy || !orch?.turns.length;
  paintRunning();
  parts.orchLoading.hidden = Boolean(orch);
  parts.say.disabled = busy || !orch || orch.thinking;
  paintMic();
  if (!orch) return;
  const label = engineLabel(orch.engineId);
  parts.earlier.hidden = !orch.earlier;
  if (orch.earlier) parts.earlier.textContent = tCount("phone.orchEarlier", orch.earlier);
  parts.startHere.hidden = orch.turns.length > 0 || orch.thinking;
  parts.startBody.textContent = t("orch.empty.body", { engine: label });
  parts.notReady.hidden = orch.engineReady;
  parts.notReady.textContent = t("phone.orchNotReady", { engine: label });
  const changed = paintTurns();
  parts.thinking.hidden = !orch.thinking;
  parts.thinkingText.textContent = t("orch.thinking", { engine: label });
  parts.thinkingStop.disabled = busy;
  for (const button of parts.turnList.querySelectorAll("button[data-act]")) button.disabled = busy || button.dataset.off === "1";
  const key = JSON.stringify([changed, orch.turns.length, orch.thinking, orch.engineReady]);
  if (key !== parts.orchTurnsKey) {
    parts.orchTurnsKey = key;
    if (parts.stickTurns && !editingIn(parts.turns)) parts.turns.scrollTop = parts.turns.scrollHeight;
  }
}

/** The planner list, rebuilt only when it changes and never while it is open. */
function paintPlanner() {
  const select = parts.planner;
  select.disabled = busy || !orch;
  if (!orch || document.activeElement === select) return;
  const key = JSON.stringify([orch.planners, orch.engineId]);
  if (key === parts.plannerKey) return;
  parts.plannerKey = key;
  const options = orch.planners.map((engine) => el("option", { value: engine.id }, `${engine.label}${engine.available ? "" : ` ${t("common.notOnPath")}`}`));
  if (!orch.planners.some((engine) => engine.id === orch.engineId)) options.unshift(el("option", { value: orch.engineId }, orch.engineId));
  select.replaceChildren(...options);
  select.value = orch.engineId;
}

/**
 * The conversation, one node per turn, rebuilt only when that turn changed. A plan card someone
 * is typing in waits until they leave it. Returns whether anything moved.
 */
function paintTurns() {
  // A plan card names CLIs, workspaces and running terminals, so it is redrawn when those change.
  const context = JSON.stringify([orch.engines, orch.workspaces, orch.running.map((item) => [item.ptyId, item.label]), [...pendingSteps]]);
  const seen = new Set();
  let previous = null;
  let changed = false;
  for (const turn of orch.turns) {
    seen.add(turn.id);
    const key = JSON.stringify(turn) + context;
    let entry = parts.orchTurns.get(turn.id);
    let fresh = false;
    // A card is left alone while someone types in it, unless its plan has gone ahead (or been dropped) meanwhile.
    if (!entry || (entry.key !== key && !(turn.plan === "waiting" && editingIn(entry.node)))) {
      const node = turnNode(turn);
      if (entry) entry.node.replaceWith(node);
      entry = { key, node };
      parts.orchTurns.set(turn.id, entry);
      fresh = true;
    }
    const want = previous ? previous.nextSibling : parts.turnList.firstChild;
    if (entry.node !== want) {
      parts.turnList.insertBefore(entry.node, want);
      fresh = true;
    }
    // A box can only be measured once it is on the page.
    if (fresh) sizePrompts(entry.node);
    changed ||= fresh;
    previous = entry.node;
  }
  for (const [id, entry] of parts.orchTurns) {
    if (seen.has(id)) continue;
    entry.node.remove();
    parts.orchTurns.delete(id);
    changed = true;
  }
  return changed;
}

function turnNode(turn) {
  if (turn.from === "you") return el("div", { class: "orch-turn from-you" }, el("span", { class: "orch-said" }, turn.text));
  const label = engineLabel(turn.by || orch.engineId);
  const said = turn.problem
    ? el("div", { class: "orch-problem-text" }, el("span", {}, t(`orch.problem.${turn.problem}`, { engine: label })), turn.detail ? el("span", { class: "orch-detail" }, turn.detail) : null)
    : turn.text
      ? el("span", { class: "orch-said" }, turn.text)
      : null;
  return el("div", { class: "orch-turn from-vibeforge" }, whoMark(), el("div", { class: "orch-body" }, said, turn.steps ? planCard(turn) : null));
}

function planCard(turn) {
  const steps = turn.steps || [];
  const state = turn.plan || "done";
  const waiting = state === "waiting";
  const blocked = waiting ? steps.filter((step) => step.issue).length : 0;
  const card = el(
    "div",
    { class: `orch-plan state-${state}` },
    el("div", { class: "orch-plan-head" }, el("span", { class: `chip ${PLAN_TONE[state] || "done"}` }, t(`orch.plan.${state}`)), el("span", { class: "small faint" }, tCount("orch.steps", steps.length))),
    steps.map((step) => stepNode(turn, step, waiting)),
  );
  if (waiting) {
    const note = blocked > 0 && blocked < steps.length ? tCount("orch.skipNote", blocked) : blocked === steps.length ? t("orch.fixFirst") : "";
    card.append(
      el(
        "div",
        { class: "orch-plan-foot" },
        el("span", { class: "small faint grow" }, note),
        el("button", { class: "ghost", type: "button", "data-act": "cancel", disabled: busy, onclick: () => void cancelPlan(turn, card) }, t("common.cancel")),
        el("button", { class: "btn", type: "button", "data-act": "go", "data-off": blocked === steps.length ? "1" : "0", disabled: busy || blocked === steps.length, onclick: () => void goPlan(turn, card) }, t("orch.go")),
      ),
    );
  }
  return card;
}

function stepNode(turn, step, editable) {
  const pending = pendingSteps.get(step.id) || {};
  const value = (key) => (key in pending ? pending[key] : step[key]);
  const icon =
    step.state === "running"
      ? el("span", { class: "px working", "aria-hidden": "true" })
      : glyph(step.state === "done" ? "done" : step.state === "failed" ? "failed" : step.kind);
  const main = el("div", { class: "orch-step-main" });
  if (step.kind === "start") {
    if (editable) {
      main.append(el("div", { class: "orch-step-line" }, enginePick(turn, step, value("engineId")), workspacePick(turn, step, value("workspaceId"))), branchField(turn, step, value("branch")));
    } else {
      const workspace = orch.workspaces.find((item) => item.id === step.workspaceId)?.name || step.asked;
      main.append(
        el(
          "div",
          { class: "orch-step-line" },
          el("strong", {}, engineLabel(step.engineId)),
          el("span", { class: "faint" }, "·"),
          el("span", {}, workspace),
          step.branch ? el("span", { class: "orch-branch-text" }, glyph("branch"), step.branch) : null,
        ),
      );
    }
  } else {
    const target = orch.running.find((item) => item.ptyId === step.target);
    main.append(el("div", { class: "orch-step-line" }, el("strong", {}, step.kind === "tell" ? t("orch.tell") : t("orch.close")), el("span", { class: "orch-target" }, target?.label || step.asked || t("orch.gone"))));
  }
  if (step.kind !== "stop") main.append(editable ? promptField(turn, step, value("prompt")) : el("span", { class: "orch-prompt-text" }, step.prompt));
  if (step.issue) main.append(el("span", { class: "orch-issue" }, t(ISSUE_KEYS[step.issue] || "orch.fixFirst", { asked: step.asked || "?" })));
  if (step.state === "failed" && step.error) main.append(el("span", { class: "orch-error" }, step.error));
  if (step.state === "skipped") main.append(el("span", { class: "small faint" }, t("orch.skipped")));
  if (step.state === "done" && step.kind === "start" && step.ptyId) {
    main.append(
      el(
        "div",
        { class: "orch-step-actions" },
        el(
          "button",
          { class: "ghost small-btn", type: "button", "data-act": "open", "data-off": step.live ? "0" : "1", disabled: busy || !step.live, onclick: () => openSession({ ptyId: step.ptyId, runId: step.runId || "" }) },
          t("phone.orchOpen"),
        ),
      ),
    );
  }
  const remove = editable
    ? el("button", { class: "ghost orch-step-x", type: "button", "data-act": "remove", "aria-label": t("orch.removeStep"), title: t("orch.removeStep"), disabled: busy, onclick: () => void removeStep(turn, step) }, glyph("remove"))
    : null;
  return el("div", { class: `orch-step step-${step.state}${step.issue ? " has-issue" : ""}`, "data-step": step.id }, el("span", { class: "orch-step-icon" }, icon), main, remove);
}

/** Every CLI, the ones not on the computer's PATH greyed out (EnginePick on the desktop). */
function enginePick(turn, step, value) {
  const engines = orch.engines;
  const select = el(
    "select",
    { "aria-label": t("orch.engine"), "data-field": "engineId" },
    engines.some((engine) => engine.id === value) ? null : el("option", { value: "" }, t("orch.pickEngine")),
    engines.map((engine) => el("option", { value: engine.id, disabled: !engine.available && engine.id !== value }, `${engine.label}${engine.available ? "" : ` ${t("common.notOnPath")}`}`)),
  );
  select.value = value;
  select.addEventListener("change", () => editStep(turn, step, { engineId: select.value }));
  return select;
}

function workspacePick(turn, step, value) {
  const workspaces = orch.workspaces;
  const select = el(
    "select",
    { "aria-label": t("orch.workspace"), "data-field": "workspaceId" },
    workspaces.some((item) => item.id === value) ? null : el("option", { value: "" }, t("orch.pickWorkspace")),
    workspaces.map((item) => el("option", { value: item.id }, item.name)),
  );
  select.value = value;
  select.addEventListener("change", () => editStep(turn, step, { workspaceId: select.value }));
  return select;
}

/** The new branch, in its own copy of the workspace. Empty: no copy (a folder that isn't a git repository). */
function branchField(turn, step, value) {
  const input = el("input", { class: "orch-branch-input", "data-field": "branch", autocapitalize: "off", autocorrect: "off", spellcheck: "false", placeholder: t("orch.noBranch"), "aria-label": t("orch.branch") });
  input.value = value;
  input.addEventListener("blur", () => {
    const next = input.value.trim();
    if (next !== currentStep(step, "branch")) editStep(turn, step, { branch: next });
  });
  return el("label", { class: "orch-branch", title: t("orch.branchTip") }, glyph("branch"), input);
}

/** What it is asked to do, as tall as its words (up to a point), so the whole instruction reads before Go. */
function promptField(turn, step, value) {
  const box = el("textarea", { class: "orch-prompt", "data-field": "prompt", "aria-label": t("orch.prompt") });
  box.value = value;
  box.addEventListener("input", () => sizePrompt(box));
  box.addEventListener("blur", () => {
    if (box.value !== currentStep(step, "prompt")) editStep(turn, step, { prompt: box.value });
  });
  return box;
}

function sizePrompt(box) {
  box.style.height = "0px";
  box.style.height = `${Math.min(240, Math.max(44, box.scrollHeight + 2))}px`;
}

function sizePrompts(node) {
  for (const box of node.querySelectorAll("textarea.orch-prompt")) sizePrompt(box);
}

/** A step's field as the computer will have it once the changes on their way have landed. */
function currentStep(step, key) {
  const pending = pendingSteps.get(step.id);
  return pending && key in pending ? pending[key] : step[key];
}

/** A change made on the card before Go, sent at once. A poll before it lands shows it too. */
function editStep(turn, step, patch) {
  const pending = { ...(pendingSteps.get(step.id) || {}), ...patch };
  pendingSteps.set(step.id, pending);
  const sent = stepQueue.then(() => post("/api/orchestrator/step", { turnId: turn.id, stepId: step.id, patch }));
  stepQueue = sent.then(
    () => undefined,
    () => undefined,
  );
  sent
    .catch((err) => {
      error = err.message;
    })
    .finally(() => {
      if (pendingSteps.get(step.id) === pending) pendingSteps.delete(step.id);
      void refresh();
    });
  return sent;
}

/** Whatever is typed on the card and not sent yet: iOS doesn't always take the focus off a box when Go is tapped. */
function flushStepEdits(turn, card) {
  for (const step of turn.steps || []) {
    const row = [...card.querySelectorAll("[data-step]")].find((node) => node.dataset.step === step.id);
    if (!row) continue;
    const patch = {};
    for (const field of row.querySelectorAll("[data-field]")) {
      const key = field.dataset.field;
      const next = key === "branch" ? field.value.trim() : field.value;
      if (next !== currentStep(step, key)) patch[key] = next;
    }
    if (Object.keys(patch).length) editStep(turn, step, patch);
  }
}

/** Done with the card: what was typed on it is sent, and the box lets go so the card can show what happens next. */
function leaveCard(turn, card) {
  flushStepEdits(turn, card);
  if (card.contains(document.activeElement)) document.activeElement.blur();
}

async function goPlan(turn, card) {
  leaveCard(turn, card);
  parts.stickTurns = true;
  await withBusy(async () => {
    await stepQueue;
    await post("/api/orchestrator/go", { turnId: turn.id });
    return true;
  });
}

function cancelPlan(turn, card) {
  if (card.contains(document.activeElement)) document.activeElement.blur();
  return withBusy(() => post("/api/orchestrator/cancel", { turnId: turn.id }));
}

function removeStep(turn, step) {
  if (document.activeElement?.closest?.(".orch-plan")) document.activeElement.blur();
  return withBusy(() => post("/api/orchestrator/remove", { turnId: turn.id, stepId: step.id }));
}

async function askOrch() {
  const said = parts.box.value.trim();
  if (!said || !orch || orch.thinking) return;
  parts.stickTurns = true;
  const sent = await withBusy(async () => {
    await post("/api/orchestrator/ask", { text: said });
    return true;
  });
  if (!sent) return;
  orchDraft = "";
  if (parts.box) parts.box.value = "";
}

function stopThinking() {
  return withBusy(() => post("/api/orchestrator/stop", {}));
}

function newTalk() {
  return withBusy(() => post("/api/orchestrator/new", {}));
}

function saveOrch(patch) {
  return withBusy(() => post("/api/orchestrator/settings", patch));
}

/** "Running · 3": every coding CLI on the computer, the Orchestrator's first. The list opens over the page. */
function paintRunning() {
  const running = orch?.running ?? [];
  const own = running.filter((item) => item.orchestrated);
  parts.runningOpen.hidden = running.length === 0;
  const key = JSON.stringify([running, busy]);
  if (key === parts.runningKey) return;
  parts.runningKey = key;
  const lit = running.some((item) => item.state === "working") ? "working" : "waiting";
  parts.runningOpen.replaceChildren(
    ...[
      el("span", { class: `px ${lit}`, "aria-hidden": "true" }),
      el("span", { class: "grow" }, `${t("orch.team")} · ${running.length}`),
      own.length ? el("span", { class: "small faint" }, `${t("orch.mine")} · ${own.length}`) : null,
      el("span", { class: "chev", "aria-hidden": "true" }),
    ].filter(Boolean),
  );
  const rows = running.map((item) =>
    el(
      "div",
      { class: `orch-member ${item.state}` },
      el(
        "button",
        { class: "orch-member-open", type: "button", onclick: () => openSession({ ptyId: item.ptyId, runId: item.runId || "" }) },
        el("span", { class: `px ${item.state}`, "aria-hidden": "true" }),
        el(
          "span",
          { class: "grow orch-member-copy" },
          el("span", { class: "title" }, item.name, item.orchestrated ? el("span", { class: "orch-mine" }, ` · ${t("orch.mine")}`) : null),
          el("span", { class: "small muted" }, item.workspace),
        ),
        el("span", { class: `pill ${item.state}` }, stateLabel(item.state)),
      ),
      el("button", { class: "ghost small-btn", type: "button", disabled: busy, onclick: () => void stopOne(item) }, item.stop === "interrupt" ? t("phone.interrupt") : t("orch.stopOne")),
    ),
  );
  parts.runningList.replaceChildren(
    ...[
      own.length ? el("div", { class: "orch-team-head" }, el("button", { class: "ghost danger", type: "button", disabled: busy, onclick: () => void stopAll(own) }, t("orch.stopAll"))) : null,
      running.length ? null : el("p", { class: "small faint" }, t("orch.teamEmpty")),
      ...rows,
    ].filter(Boolean),
  );
}

/** Stop as the phone stops: a run's terminal closes; a CLI typed into a shell is interrupted and the shell stays. */
async function stopOne(item) {
  if (!window.confirm(item.stop === "interrupt" ? t("phone.askInterrupt") : t("phone.askStop"))) return;
  await withBusy(() => post("/api/stop", { ptyId: item.ptyId }));
}

/** Stop all: only the CLIs the Orchestrator started, as on the desktop, which asks first too. */
async function stopAll(own) {
  if (!window.confirm(`${tCount("orch.stopAllTitle", own.length)}\n\n${t("orch.stopAllBody")}`)) return;
  await withBusy(() => Promise.all(own.map((item) => post("/api/stop", { ptyId: item.ptyId }))));
}

// ---------------------------------------------------------------- talking to it

// The mic records on the phone and the computer's own whisper hears it (Settings → Voice there),
// told the same names as the desktop's box. The words land in the box and wait for Send. Tap to
// start and tap again to stop, or hold and let go: src/ui/mic.ts on the desktop.

/** A press shorter than this is a tap: it keeps listening until the next tap (MIC_TAP_MS on the desktop). */
const MIC_TAP_MS = 350;
/** A recording stops by itself after this long, as on the computer. */
const MIC_MAX_SECONDS = 180;
/** What whisper takes: 16 kHz mono. */
const HEAR_RATE = 16000;
const METER_CELLS = 10;
const EMPTY_HEARD = { short: "phone.micShort", silent: "voice.empty.silent", nothing: "voice.empty.nothing" };

/** The recording, while there is one: starting (the phone asks for the mic), recording, or being heard. */
let mic = null;
/** A short note after a recording that gave no words. */
let micSaid = { text: "", until: 0 };

function micSupported() {
  return Boolean(window.isSecureContext && navigator.mediaDevices?.getUserMedia && window.AudioContext && window.AudioWorkletNode);
}

function micButton() {
  const button = el("button", { class: "ghost mic", type: "button", hidden: true, "aria-label": t("phone.mic"), title: t("phone.mic") }, glyph("mic"));
  let press = null;
  button.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || button.disabled) return;
    event.preventDefault();
    try {
      button.setPointerCapture(event.pointerId);
    } catch {
      /* not every pointer can be captured */
    }
    // A press while it listens is the tap that stops it, on release.
    press = { at: Date.now(), started: !mic };
    if (!mic) micBegin();
  });
  button.addEventListener("pointerup", (event) => {
    const held = press;
    press = null;
    if (held && event.button === 0) micRelease(held, false);
  });
  button.addEventListener("pointercancel", () => {
    const held = press;
    press = null;
    if (held) micRelease(held, true);
  });
  // Enter or Space on the focused button: a tap, with no hold to measure.
  button.addEventListener("click", (event) => {
    if (event.detail !== 0) return;
    if (mic) void micFinish();
    else {
      micBegin();
      if (mic) mic.latched = true;
    }
  });
  button.addEventListener("contextmenu", (event) => event.preventDefault());
  return button;
}

/** Letting go: a tap (or a press the phone's own question about the mic interrupted) keeps listening; a hold, or the tap that ends it, finishes. */
function micRelease(held, cancelled) {
  const current = mic;
  if (!current || current.phase === "hearing") return;
  if (held.started && (current.phase === "starting" || (!cancelled && Date.now() - held.at < MIC_TAP_MS))) {
    current.latched = true;
    paintMic();
    return;
  }
  void micFinish();
}

function micSeconds(current) {
  return current.ctx ? current.length / current.ctx.sampleRate : 0;
}

/** How full the meter is: the loudness of the last stretch on -60…0 dBFS (meterLevel on the computer). */
function loudness(samples) {
  let sum = 0;
  for (let i = 0; i < samples.length; i += 1) sum += samples[i] * samples[i];
  const value = Math.sqrt(sum / Math.max(1, samples.length));
  if (value <= 0) return 0;
  return Math.max(0, Math.min(1, (20 * Math.log10(value) + 60) / 60));
}

function micBegin() {
  if (mic) return;
  const mine = { phase: "starting", latched: false, finish: false, chunks: [], length: 0, level: 0, ctx: null, stream: null, source: null, node: null, timer: 0 };
  micSaid = { text: "", until: 0 };
  try {
    // Made inside the tap itself, or iOS keeps it silent.
    mine.ctx = new AudioContext();
    void mine.ctx.resume().catch(() => undefined);
  } catch {
    showMicNote(t("phone.micFailed"));
    return;
  }
  mic = mine;
  paintMic();
  void (async () => {
    try {
      mine.stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      await mine.ctx.audioWorklet.addModule("/mic-worklet.js");
      if (mic !== mine) {
        closeMic(mine);
        return;
      }
      mine.source = mine.ctx.createMediaStreamSource(mine.stream);
      mine.node = new AudioWorkletNode(mine.ctx, "vibeforge-mic");
      mine.node.port.onmessage = (event) => {
        mine.chunks.push(event.data);
        mine.length += event.data.length;
        mine.level = loudness(event.data);
      };
      mine.source.connect(mine.node);
      // Connected through to the speakers so it keeps running; it writes nothing, so nothing plays.
      mine.node.connect(mine.ctx.destination);
      if (mine.ctx.state === "suspended") await mine.ctx.resume();
      mine.phase = "recording";
      mine.timer = window.setInterval(() => {
        if (mic !== mine) return;
        if (micSeconds(mine) >= MIC_MAX_SECONDS) void micFinish();
        else paintMic();
      }, 200);
      paintMic();
      if (mine.finish) void micFinish();
    } catch (err) {
      closeMic(mine);
      if (mic !== mine) return;
      mic = null;
      showMicNote(err && err.name === "NotAllowedError" ? t("phone.micBlocked") : t("phone.micFailed"));
    }
  })();
}

/** Lets go of the microphone and the audio it went through. */
function closeMic(current) {
  window.clearInterval(current.timer);
  try {
    current.source?.disconnect();
    current.node?.disconnect();
    if (current.node) current.node.port.onmessage = null;
  } catch {
    /* already disconnected */
  }
  for (const track of current.stream?.getTracks() || []) track.stop();
  void current.ctx?.close().catch(() => undefined);
}

function micCancel() {
  const current = mic;
  if (!current || current.phase === "hearing") return;
  mic = null;
  closeMic(current);
  paintMic();
}

/** The recording as whisper wants it: 16 kHz mono signed 16-bit, each output sample the average of the input it covers. */
function toPcm(chunks, length, rate) {
  const all = new Float32Array(length);
  let at = 0;
  for (const chunk of chunks) {
    all.set(chunk.subarray(0, Math.min(chunk.length, length - at)), at);
    at += chunk.length;
  }
  const ratio = rate / HEAR_RATE;
  // The cap is checked every 200 ms, so a recording that reached it runs a little over: the computer takes three minutes exactly.
  const out = new Int16Array(Math.min(Math.floor(length / ratio), HEAR_RATE * MIC_MAX_SECONDS));
  for (let i = 0; i < out.length; i += 1) {
    const start = Math.floor(i * ratio);
    const end = Math.min(length, Math.max(start + 1, Math.floor((i + 1) * ratio)));
    let sum = 0;
    for (let j = start; j < end; j += 1) sum += all[j];
    const value = Math.max(-1, Math.min(1, sum / (end - start)));
    out[i] = value < 0 ? value * 0x8000 : value * 0x7fff;
  }
  return out;
}

/** Dictated words joined onto what is already in the box, with one space between (joinDictation on the desktop). */
function joinDictation(before, said) {
  if (!before.trim()) return said;
  return /\s$/.test(before) ? before + said : `${before} ${said}`;
}

async function micFinish() {
  const mine = mic;
  if (!mine || mine.phase === "hearing") return;
  if (mine.phase === "starting") {
    mine.finish = true;
    return;
  }
  mine.phase = "hearing";
  closeMic(mine);
  paintMic();
  try {
    const pcm = toPcm(mine.chunks, mine.length, mine.ctx.sampleRate);
    let response;
    try {
      response = await fetch("/api/orchestrator/hear", { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/octet-stream" }, body: pcm });
    } catch {
      throw new Error(t("phone.offline"));
    }
    const body = await response.json().catch(() => ({}));
    if (response.status === 401) {
      forget();
      return;
    }
    if (!response.ok) throw new Error(body.error || t("phone.error.failed"));
    if (body.text) {
      const box = view === "maestro" ? parts.box : null;
      orchDraft = joinDictation(box ? box.value : orchDraft, body.text);
      if (box) box.value = orchDraft;
    } else showMicNote(t(EMPTY_HEARD[body.empty] || "voice.empty.nothing"));
  } catch (err) {
    error = err.message;
    update();
  } finally {
    if (mic === mine) mic = null;
    paintMic();
  }
}

function showMicNote(text) {
  micSaid = { text, until: Date.now() + 6000 };
  paintMic();
  window.setTimeout(paintMic, 6100);
}

function paintMic() {
  const button = parts.mic;
  if (!button || view !== "maestro" || !button.isConnected) return;
  const phase = mic?.phase ?? "idle";
  button.hidden = !mic && !(orch?.hear && micSupported());
  if (button.dataset.phase !== phase) {
    button.dataset.phase = phase;
    button.replaceChildren(phase === "hearing" ? el("span", { class: "px working", "aria-hidden": "true" }) : glyph(phase === "recording" ? "stop" : "mic"));
  }
  button.classList.toggle("live", phase === "recording" || phase === "starting");
  button.setAttribute("aria-pressed", String(phase === "recording"));
  button.disabled = phase === "hearing";
  const note = parts.micNote;
  const listening = phase === "recording" || phase === "starting";
  const said = !mic && micSaid.text && Date.now() < micSaid.until;
  note.hidden = !listening && phase !== "hearing" && !said;
  note.classList.toggle("said", Boolean(said));
  parts.micMeter.hidden = !listening;
  parts.micBusy.hidden = phase !== "hearing";
  parts.micClock.hidden = !listening;
  parts.micCancel.hidden = !listening;
  if (listening) {
    const lit = Math.round((mic.level || 0) * METER_CELLS);
    [...parts.micMeter.children].forEach((cell, index) => {
      cell.className = index < lit ? (index >= METER_CELLS - 2 ? "hot" : "on") : "";
    });
    const seconds = Math.floor(micSeconds(mic));
    parts.micWord.textContent = t("voice.listening");
    parts.micClock.textContent = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
    parts.micHint.textContent = mic.latched || phase === "starting" ? t("phone.micTap") : t("phone.micHold");
  } else if (phase === "hearing") {
    parts.micWord.textContent = t("voice.transcribing");
    parts.micHint.textContent = "";
  } else if (said) {
    parts.micWord.textContent = "";
    parts.micHint.textContent = micSaid.text;
  }
}

let installEvent = null;

function installedApp() {
  return window.matchMedia("(display-mode: fullscreen)").matches || window.matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
}

function offerInstall() {
  const card = document.querySelector(".install");
  const touch = window.matchMedia("(pointer: coarse)").matches || navigator.maxTouchPoints > 0;
  const narrow = window.matchMedia("(max-width: 640px)").matches;
  const phone = touch || narrow || /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
  if (installedApp() || localStorage.getItem(INSTALL_KEY) === "1" || !phone) {
    card?.remove();
    return;
  }
  if (card) return;
  const ios = /iPhone|iPad|iPod/i.test(navigator.userAgent);
  const copy = el("p", {}, ios ? t("phone.installIos") : t("phone.installBody"));
  const install = ios
    ? null
    : el("button", { class: "btn", type: "button", onclick: () => void acceptInstall(copy) }, t("phone.install"));
  const later = el("button", { class: "ghost", type: "button", onclick: dismissInstall }, t("phone.installLater"));
  document.body.append(
    el(
      "div",
      { class: "install", role: "dialog", "aria-label": t("phone.installTitle") },
      el("div", { class: "install-title" }, t("phone.installTitle")),
      copy,
      el("div", { class: "actions" }, install, later),
    ),
  );
}

async function acceptInstall(copy) {
  if (!installEvent) {
    copy.textContent = t("phone.installMenu");
    return;
  }
  const event = installEvent;
  installEvent = null;
  await event.prompt();
  const choice = await event.userChoice;
  if (choice?.outcome === "accepted") document.querySelector(".install")?.remove();
}

function dismissInstall() {
  localStorage.setItem(INSTALL_KEY, "1");
  document.querySelector(".install")?.remove();
}

window.addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault();
  installEvent = event;
  offerInstall();
});

window.addEventListener("appinstalled", () => {
  installEvent = null;
  localStorage.setItem(INSTALL_KEY, "1");
  document.querySelector(".install")?.remove();
});

/**
 * Keep the page inside the visible screen while the phone keyboard is open.
 * The layout viewport stays full height on iOS; the visual viewport is the part
 * the keyboard has not covered. Chrome also honours interactive-widget on the
 * viewport tag, and then this inset is zero.
 */
function followKeyboard() {
  const vv = window.visualViewport;
  const height = vv && vv.height > 0 ? vv.height : window.innerHeight;
  const top = vv ? vv.offsetTop : 0;
  if (!(height > 0)) return;
  const keyboard = Math.max(0, window.innerHeight - top - height);
  const root = document.documentElement;
  root.style.setProperty("--vv-top", `${top}px`);
  root.style.setProperty("--vv-height", `${height}px`);
  root.style.setProperty("--keyboard", `${keyboard}px`);
  const opened = keyboard > 60;
  root.classList.toggle("keyboard", opened);
  if (opened !== keyboardWasOpen) {
    keyboardWasOpen = opened;
    const focused = document.activeElement;
    if (focused instanceof HTMLTextAreaElement || focused instanceof HTMLInputElement || focused instanceof HTMLSelectElement) {
      focused.scrollIntoView({ block: "nearest" });
    }
  }
}

let keyboardWasOpen = false;

if (window.visualViewport) {
  let frame = 0;
  const trackKeyboard = () => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(followKeyboard);
  };
  visualViewport.addEventListener("resize", trackKeyboard);
  visualViewport.addEventListener("scroll", trackKeyboard);
}
followKeyboard();

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.addEventListener("message", (event) => {
    if (event.data?.type !== "open") return;
    openSession({ ptyId: event.data.ptyId || "", runId: event.data.runId || "" });
  });
  void navigator.serviceWorker.register("/sw.js");
}

// Back on the page after the phone was locked: what changed shows now, not at the next poll.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") void refresh();
});

void loadWords().then(() => {
  show();
  offerInstall();
  if (token) void refresh();
});
