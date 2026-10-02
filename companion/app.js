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

function ago(iso) {
  if (!iso) return "";
  const seconds = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (!Number.isFinite(seconds)) return "";
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}

function stateLabel(state) {
  if (state === "working") return "Working";
  if (state === "waiting") return "Waiting";
  return "Finished";
}

async function call(path, options = {}) {
  const headers = { ...(options.body ? { "Content-Type": "application/json" } : {}) };
  if (token) headers.Authorization = `Bearer ${token}`;
  let response;
  try {
    response = await fetch(path, { method: options.method || "GET", headers, body: options.body });
  } catch {
    throw Object.assign(new Error("The computer is not serving the page."), { offline: true });
  }
  const body = await response.json().catch(() => ({}));
  if (response.status === 401 && path !== "/api/pair") {
    forget();
    throw new Error(body.error || "Enter the pairing code from Settings on the computer.");
  }
  if (!response.ok) throw Object.assign(new Error(body.error || "Something went wrong."), { working: body.working === true });
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
      if (item.state === "waiting" && previous.state === "working") void buzz(`${item.title} is waiting`, { key, ptyId: item.ptyId || "", runId: item.runId || "" });
      if (item.state === "done") void buzz(`${item.title} finished${item.changes ? ` · ${item.changes}` : ""}`, { key, ptyId: "", runId: item.runId || "" });
    }
  }
  if (primed) {
    for (const [key, previous] of known) {
      if (next.has(key) || previous.state === "done") continue;
      void buzz(`${previous.title} finished`, { key, ptyId: "", runId: previous.runId || "" });
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
  parts.pair = el("button", { class: "btn", type: "button", onclick: () => void pair(input.value) }, "Continue");
  return el(
    "section",
    {},
    el("div", { class: "top" }, el("h1", {}, "VibeForge")),
    el("p", { class: "muted" }, "Enter the pairing code from Settings → Phone on the computer."),
    el("div", { class: "card stack" }, el("label", {}, "Pairing code", input), parts.pair),
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
    if (!response.ok) throw new Error(body.error || "That code did not match.");
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
    "Buzz me",
  );
  parts.list = el("div", {});
  parts.listKey = null;
  return el("section", {}, el("div", { class: "top" }, el("h1", { class: "grow" }, "Desk"), parts.buzz), parts.list);
}

function updateDesk() {
  parts.buzz.hidden = !(typeof Notification !== "undefined" && Notification.permission === "default");
  if (!desk) return;
  // The list has no inputs, so it is redrawn whole, but only when something on it changed (or a minute passed).
  const key = JSON.stringify([desk.workspaces, Math.floor(Date.now() / 60000)]);
  if (key === parts.listKey) return;
  parts.listKey = key;
  parts.list.replaceChildren(
    ...(desk.workspaces.length ? desk.workspaces.map((workspace) => workspaceCard(workspace)) : [el("div", { class: "card muted" }, "No workspaces yet. Add one on the computer.")]),
  );
}

function workspaceCard(workspace) {
  const start = workspace.id ? el("button", { class: "ghost", type: "button", onclick: () => openLaunch(workspace.id) }, "Start") : null;
  return el(
    "article",
    { class: "card" },
    el("div", { class: "row" }, el("div", { class: "grow" }, el("div", { class: "title" }, workspace.name), workspace.folder ? el("div", { class: "small faint" }, workspace.folder) : null), start),
    workspace.sessions.length ? workspace.sessions.map((item) => sessionButton(item)) : el("p", { class: "small faint" }, "Nothing running."),
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
    item.alsoHere?.length ? el("div", { class: "small faint" }, `Also here: ${item.alsoHere.join(", ")}`) : null,
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
  const back = el("button", { class: "back", type: "button", onclick: () => setView("desk") }, "Desk");
  const top = el("div", { class: "top" }, back, el("h1", {}, workspace?.name || "Start"));
  if (!agents.length && !engines.length) {
    return el("section", {}, top, el("div", { class: "card muted" }, "No coding CLI was found on the computer, and no agent is allowed here."));
  }
  const select = el(
    "select",
    { id: "who" },
    agents.length ? el("optgroup", { label: "Agents" }, agents.map((agent) => el("option", { value: `agent:${agent.id}` }, `${agent.name}${agent.engine ? ` · ${agent.engine}` : ""}`))) : null,
    engines.length ? el("optgroup", { label: "CLIs" }, engines.map((engine) => el("option", { value: `engine:${engine.id}` }, engine.label))) : null,
  );
  const prompt = el("textarea", { id: "prompt", placeholder: "What should they do? Leave this empty to start and wait." });
  parts.start = el("button", { class: "btn", type: "button", onclick: () => void startAgent(select.value, prompt) }, "Start");
  return el(
    "section",
    {},
    top,
    el("div", { class: "card stack" }, el("label", {}, "Who", select), el("label", {}, "First prompt", prompt), parts.start),
    agents.length ? null : el("p", { class: "small faint" }, "No agent is allowed in this folder, so only a CLI on its own can start here."),
  );
}

function updateLaunch() {
  if (!parts.start) return;
  parts.start.disabled = busy;
  parts.start.textContent = busy ? "Starting…" : "Start";
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
  parts.title = el("h1", { class: "grow" }, "Session");
  parts.pill = el("span", { class: "pill", hidden: true });
  parts.meta = el("p", { class: "small muted", hidden: true });
  parts.screen = el("pre", { class: "screen" }, "Loading…");
  parts.stick = true;
  parts.prompt = el("textarea", { id: "prompt", placeholder: "Tell them what to do next" });
  parts.nudges = el("div", { class: "actions", hidden: true });
  parts.nudgesKey = null;
  parts.send = el("button", { class: "btn", type: "button", onclick: () => void sendText(parts.prompt.value, true) }, "Send");
  parts.stop = el("button", { class: "ghost", type: "button", hidden: true, onclick: () => void stopSession() }, "Stop");
  // Follow the end of the screen unless the person scrolled up to read.
  parts.screen.addEventListener("scroll", () => {
    const pre = parts.screen;
    parts.stick = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 24;
  });
  return el(
    "section",
    {},
    el("div", { class: "top" }, el("button", { class: "back", type: "button", onclick: () => { session = null; setView("desk"); } }, "Desk"), parts.title, parts.pill),
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
  parts.send.textContent = busy ? "Sending…" : "Send";
  if (!session) return;
  parts.title.textContent = session.title;
  parts.pill.hidden = false;
  parts.pill.className = `pill ${session.state}`;
  parts.pill.textContent = stateLabel(session.state);
  const meta = [session.detail, session.changes].filter(Boolean).join(" · ");
  parts.meta.hidden = !meta;
  parts.meta.textContent = meta;
  parts.prompt.placeholder = session.state === "done" ? "What should they do next?" : "Tell them what to do next";
  parts.stop.hidden = !session.stop;
  parts.stop.disabled = busy;
  parts.stop.textContent = session.stop === "interrupt" ? "Interrupt" : "Stop";
  const screen = session.screen || "Nothing on screen yet.";
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
    if (!window.confirm("Still working. Send anyway?")) return;
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
      if (!window.confirm("Still working. Send anyway?")) return false;
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
  const ask = session.stop === "interrupt" ? "Interrupt what it is doing? The terminal stays open." : "Stop this session?";
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

show();
if (token) {
  schedule();
  void refresh();
}
