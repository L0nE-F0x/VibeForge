const TOKEN_KEY = "vibeforge-phone";
const app = document.querySelector("#app");

let token = localStorage.getItem(TOKEN_KEY) || "";
let view = token ? "desk" : "pair";
let desk = null;
let session = null;
let sessionQuery = { ptyId: "", runId: "" };
let launchWorkspace = "";
let error = "";
let busy = false;
let known = new Map();
let primed = false;
let timer = 0;
let ticket = 0;
/** The page's words in the phone's language, from the app's own catalogs (GET /api/text). */
let words = {};
let language = "en";
let plans = null;
let plansAt = 0;
const PLANS_EVERY_MS = 60_000;
const PLAN_NAMES = { claude: "Claude", codex: "Codex", grok: "Grok", kimi: "Kimi" };
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
  const text = words[key] ?? key;
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
  let response;
  try {
    response = await fetch(path, { method: options.method || "GET", headers, body: options.body });
  } catch {
    throw Object.assign(new Error(t("phone.offline")), { offline: true });
  }
  const body = await response.json().catch(() => ({}));
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
  view = "pair";
  desk = null;
  session = null;
}

async function buzz(body, data) {
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

async function refresh() {
  if (!token || view === "pair") return;
  const mine = ++ticket;
  const shown = view;
  try {
    const payload = await call("/api/desk");
    // Plan limits move slowly, and reading them may ask the providers: once a minute is plenty.
    if (Date.now() - plansAt > PLANS_EVERY_MS) {
      plansAt = Date.now();
      plans = (await call("/api/plans").catch(() => ({ plans }))).plans ?? null;
    }
    const next = view === "session" ? await call(`/api/session?ptyId=${encodeURIComponent(sessionQuery.ptyId)}&runId=${encodeURIComponent(sessionQuery.runId)}`) : null;
    // A newer poll, or a change of page, has already replaced what this one would show.
    if (mine !== ticket) return;
    watch(payload);
    desk = payload;
    if (view === "session") session = next;
    error = "";
  } catch (err) {
    if (mine !== ticket) return;
    error = err.message;
  }
  if (view !== shown) show();
  else update();
}

function schedule() {
  window.clearInterval(timer);
  if (!token) return;
  timer = window.setInterval(() => void refresh(), 2000);
}

/** Runs one action with the buttons held. Returns what the action returned, or false when it failed. */
async function withBusy(task) {
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
  update();
  void refresh();
  return result;
}

// ---------------------------------------------------------------- pages

/** Builds the page for the current view from scratch. Only a change of view does this. */
function show() {
  ticket += 1;
  parts = { banner: el("div", { class: "banner", hidden: true }) };
  app.replaceChildren(parts.banner, page());
  update();
}

/** Brings the page on show up to date without touching what is being typed. */
function update() {
  parts.banner.hidden = !error;
  parts.banner.textContent = error;
  if (view === "desk") updateDesk();
  else if (view === "launch") updateLaunch();
  else if (view === "session") updateSession();
  else if (view === "pair" && parts.pair) parts.pair.disabled = busy;
}

function setView(next) {
  view = next;
  show();
  void refresh();
}

function page() {
  if (view === "pair" || !token) return pairPage();
  if (view === "launch") return launchPage();
  if (view === "session") return sessionPage();
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
    el("div", { class: "top" }, el("h1", {}, "VibeForge")),
    el("p", { class: "muted" }, t("phone.pairLead")),
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
    schedule();
    setView("desk");
  } catch (err) {
    error = err.message;
    busy = false;
    update();
  }
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
  return el("section", {}, el("div", { class: "top" }, el("h1", { class: "grow" }, t("phone.desk")), parts.buzz), parts.plans, parts.list);
}

function updateDesk() {
  parts.buzz.hidden = !(typeof Notification !== "undefined" && Notification.permission === "default");
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

function workspaceCard(workspace) {
  const start = workspace.id ? el("button", { class: "ghost", type: "button", onclick: () => openLaunch(workspace.id) }, t("phone.start")) : null;
  return el(
    "article",
    { class: "card" },
    el("div", { class: "row" }, el("div", { class: "grow" }, el("div", { class: "title" }, workspace.id ? workspace.name : t("phone.elsewhere")), workspace.folder ? el("div", { class: "small faint" }, workspace.folder) : null), start),
    workspace.sessions.length ? workspace.sessions.map((item) => sessionButton(item)) : el("p", { class: "small faint" }, t("phone.nothingRunning")),
  );
}

function sessionButton(item) {
  return el(
    "button",
    {
      class: "session",
      type: "button",
      onclick: () => openSession({ ptyId: item.ptyId || "", runId: item.runId || "" }),
    },
    el("div", { class: "row" }, el("div", { class: "grow title" }, item.title), el("span", { class: `pill ${item.state}` }, stateLabel(item.state))),
    el("div", { class: "small muted" }, [item.detail, ago(item.endedAt || item.startedAt), item.changes].filter(Boolean).join(" · ")),
    item.alsoHere?.length ? el("div", { class: "small faint" }, t("phone.alsoHere", { names: item.alsoHere.join(", ") })) : null,
  );
}

function level(percent) {
  if (percent === null || percent === undefined || percent < 80) return "quiet";
  return percent < 100 ? "warm" : "full";
}

function bar(percent, className) {
  const fill = el("i");
  // CSSOM, not a style attribute: the page's CSP has no 'unsafe-inline'.
  fill.style.width = `${Math.max(0, Math.min(100, percent))}%`;
  return el("span", { class: className }, fill);
}

/** Plan limits, as the desktop's live popover shows them: each plan's busiest window first. */
function plansCard(summary) {
  const now = Date.now();
  return el(
    "article",
    { class: "card plans" },
    el("div", { class: "title" }, t("plans.title")),
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
          el("span", { class: "grow title" }, name, provider.limiter && rows.length ? el("span", { class: "faint" }, ` · ${provider.limiter}`) : null),
          el("b", { class: "plan-pct" }, provider.percent === null ? "—" : `${Math.round(provider.percent)}%`),
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
  setView(query.ptyId || query.runId ? "session" : "desk");
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
  const back = el("button", { class: "back", type: "button", onclick: () => setView("desk") }, t("phone.desk"));
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
    {},
    top,
    el("div", { class: "card stack" }, el("label", {}, t("phone.who"), select), el("label", {}, t("phone.firstPrompt"), prompt), parts.start),
    agents.length ? null : el("p", { class: "small faint" }, t("phone.cliOnly")),
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
  parts.pill = el("span", { class: "pill", hidden: true });
  parts.meta = el("p", { class: "small muted", hidden: true });
  parts.screen = el("pre", { class: "screen" }, t("phone.loading"));
  parts.stick = true;
  parts.prompt = el("textarea", { id: "prompt", placeholder: t("phone.next") });
  parts.nudges = el("div", { class: "actions", hidden: true });
  parts.nudgesKey = null;
  parts.send = el("button", { class: "btn", type: "button", onclick: () => void sendText(parts.prompt.value, true) }, t("phone.send"));
  parts.stop = el("button", { class: "ghost", type: "button", hidden: true, onclick: () => void stopSession() }, t("phone.stop"));
  // Follow the end of the screen unless the person scrolled up to read.
  parts.screen.addEventListener("scroll", () => {
    const pre = parts.screen;
    parts.stick = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 24;
  });
  return el(
    "section",
    {},
    el("div", { class: "top" }, el("button", { class: "back", type: "button", onclick: () => { session = null; setView("desk"); } }, t("phone.desk")), parts.title, parts.pill),
    parts.meta,
    parts.screen,
    el("div", { class: "card stack" }, parts.prompt, parts.nudges, el("div", { class: "actions" }, parts.send, parts.stop)),
  );
}

function updateSession() {
  const nudges = desk?.nudges ?? [];
  const nudgesKey = JSON.stringify([nudges, busy]);
  if (nudgesKey !== parts.nudgesKey) {
    parts.nudgesKey = nudgesKey;
    parts.nudges.hidden = !nudges.length;
    parts.nudges.replaceChildren(...nudges.map((nudge) => el("button", { class: "nudge", type: "button", disabled: busy, onclick: () => void sendText(nudge, false) }, nudge)));
  }
  parts.send.disabled = busy || !session?.canSend;
  parts.send.textContent = busy ? t("phone.sending") : t("phone.send");
  if (!session) return;
  parts.title.textContent = session.title;
  parts.pill.hidden = false;
  parts.pill.className = `pill ${session.state}`;
  parts.pill.textContent = stateLabel(session.state);
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

/** Sends the next instruction. The draft in the box is cleared only when it was the box that was sent. */
async function sendText(text, fromBox) {
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
  if (sent && fromBox && parts.prompt) parts.prompt.value = "";
}

async function stopSession() {
  if (!session?.ptyId) return;
  const ask = session.stop === "interrupt" ? t("phone.askInterrupt") : t("phone.askStop");
  if (!window.confirm(ask)) return;
  const ptyId = session.ptyId;
  await withBusy(() => post("/api/stop", { ptyId }));
}

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.addEventListener("message", (event) => {
    if (event.data?.type !== "open") return;
    openSession({ ptyId: event.data.ptyId || "", runId: event.data.runId || "" });
  });
  void navigator.serviceWorker.register("/sw.js");
}

void loadWords().then(() => {
  show();
  if (token) {
    schedule();
    void refresh();
  }
});
