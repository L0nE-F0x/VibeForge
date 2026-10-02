const TOKEN_KEY = "vibeforge-phone";
const app = document.querySelector("#app");

let token = localStorage.getItem(TOKEN_KEY) || "";
let view = token ? "desk" : "pair";
let desk = null;
let session = null;
let sessionQuery = { ptyId: "", runId: "" };
let launchWorkspace = "";
let launchAgent = "";
let error = "";
let busy = false;
let known = new Map();
let primed = false;
let timer = 0;

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
  try {
    const payload = await call("/api/desk");
    watch(payload);
    desk = payload;
    error = "";
    if (view === "session") session = await call(`/api/session?ptyId=${encodeURIComponent(sessionQuery.ptyId)}&runId=${encodeURIComponent(sessionQuery.runId)}`);
  } catch (err) {
    error = err.message;
  }
  draw();
}

function schedule() {
  window.clearInterval(timer);
  if (!token) return;
  timer = window.setInterval(() => void refresh(), 2000);
}

async function withBusy(task, clearPrompt) {
  busy = true;
  error = "";
  draw();
  try {
    await task();
    busy = false;
    if (clearPrompt) {
      const box = document.querySelector("#prompt");
      if (box) box.value = "";
    }
    await refresh();
  } catch (err) {
    error = err.message;
    busy = false;
    draw();
  }
}

function draw() {
  const prompt = document.querySelector("#prompt");
  const draft = prompt ? { value: prompt.value, start: prompt.selectionStart, focused: document.activeElement === prompt } : null;
  app.replaceChildren(banner(), page());
  const next = document.querySelector("#prompt");
  if (draft && next) {
    next.value = draft.value;
    if (draft.focused) {
      next.focus();
      next.setSelectionRange(draft.start, draft.start);
    }
  }
}

function banner() {
  return error ? el("div", { class: "banner" }, error) : null;
}

function page() {
  if (view === "pair" || !token) return pairPage();
  if (view === "launch") return launchPage();
  if (view === "session") return sessionPage();
  return deskPage();
}

function pairPage() {
  const input = el("input", { id: "code", autocapitalize: "off", autocorrect: "off", spellcheck: "false", placeholder: "vf_…" });
  return el(
    "section",
    {},
    el("div", { class: "top" }, el("h1", {}, "VibeForge")),
    el("p", { class: "muted" }, "Enter the pairing code from Settings → Phone on the computer."),
    el("div", { class: "card stack" }, el("label", {}, "Pairing code", input), el("button", { class: "btn", type: "button", onclick: () => void pair(input.value) }, "Continue")),
  );
}

async function pair(code) {
  busy = true;
  error = "";
  draw();
  try {
    const response = await fetch("/api/pair", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: code.trim() }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || "That code did not match.");
    token = code.trim();
    localStorage.setItem(TOKEN_KEY, token);
    view = "desk";
    busy = false;
    primed = false;
    known = new Map();
    await refresh();
    schedule();
  } catch (err) {
    error = err.message;
    busy = false;
    draw();
  }
}

function deskPage() {
  const workspaces = desk?.workspaces ?? [];
  const allowBuzz = typeof Notification !== "undefined" && Notification.permission === "default";
  return el(
    "section",
    {},
    el(
      "div",
      { class: "top" },
      el("h1", { class: "grow" }, "Desk"),
      allowBuzz ? el("button", { class: "ghost", type: "button", onclick: () => void Notification.requestPermission().then(() => draw()) }, "Buzz me") : null,
    ),
    workspaces.length
      ? workspaces.map((workspace) => workspaceCard(workspace))
      : el("div", { class: "card muted" }, "No workspaces yet. Add one on the computer."),
  );
}

function workspaceCard(workspace) {
  const start = workspace.id
    ? el("button", { class: "ghost", type: "button", onclick: () => openLaunch(workspace.id) }, "Start")
    : null;
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
      onclick: () => {
        sessionQuery = { ptyId: item.ptyId || "", runId: item.runId || "" };
        view = "session";
        session = null;
        void refresh();
      },
    },
    el(
      "div",
      { class: "row" },
      el("div", { class: "grow title" }, item.title),
      el("span", { class: `pill ${item.state}` }, stateLabel(item.state)),
    ),
    el(
      "div",
      { class: "small muted" },
      [item.detail, ago(item.endedAt || item.startedAt), item.changes].filter(Boolean).join(" · "),
    ),
    item.alsoHere?.length ? el("div", { class: "small faint" }, `Also here: ${item.alsoHere.join(", ")}`) : null,
  );
}

function openLaunch(workspaceId) {
  launchWorkspace = workspaceId;
  const allowed = (desk?.agents ?? []).filter((agent) => agent.workspaceIds.includes(workspaceId));
  launchAgent = allowed[0]?.id || "";
  view = "launch";
  draw();
}

function launchPage() {
  const workspace = (desk?.workspaces ?? []).find((item) => item.id === launchWorkspace);
  const allowed = (desk?.agents ?? []).filter((agent) => agent.workspaceIds.includes(launchWorkspace));
  const select = el(
    "select",
    {
      id: "agent",
      onchange: (event) => {
        launchAgent = event.target.value;
      },
    },
    allowed.map((agent) => el("option", { value: agent.id, selected: agent.id === launchAgent }, `${agent.name}${agent.engine ? ` · ${agent.engine}` : ""}`)),
  );
  const prompt = el("textarea", { id: "prompt", placeholder: "What should they do? Leave this empty to start and wait." });
  return el(
    "section",
    {},
    el("div", { class: "top" }, el("button", { class: "back", type: "button", onclick: () => { view = "desk"; draw(); } }, "Desk"), el("h1", {}, workspace?.name || "Start")),
    allowed.length
      ? el(
          "div",
          { class: "card stack" },
          el("label", {}, "Agent", select),
          el("label", {}, "First prompt", prompt),
          el("button", { class: "btn", type: "button", disabled: busy, onclick: () => void startAgent(prompt.value) }, busy ? "Starting…" : "Start"),
        )
      : el("div", { class: "card muted" }, "No agent is allowed in this workspace. Add the folder to an agent on the computer."),
  );
}

async function startAgent(prompt) {
  await withBusy(async () => {
    const result = await call("/api/launch", {
      method: "POST",
      body: JSON.stringify({ workspaceId: launchWorkspace, agentId: launchAgent, prompt }),
    });
    sessionQuery = { ptyId: result.ptyId, runId: result.runId };
    view = "session";
    session = null;
  }, true);
}

function sessionPage() {
  if (!session) return el("section", {}, el("div", { class: "top" }, el("h1", {}, "Session")), el("p", { class: "muted" }, "Loading…"));
  const prompt = el("textarea", { id: "prompt", placeholder: session.state === "done" ? "What should they do next?" : "Tell them what to do next" });
  const nudges = (desk?.nudges ?? []).map((nudge) =>
    el("button", { class: "nudge", type: "button", disabled: busy, onclick: () => void sendText(nudge, false) }, nudge),
  );
  return el(
    "section",
    {},
    el(
      "div",
      { class: "top" },
      el("button", { class: "back", type: "button", onclick: () => { view = "desk"; session = null; draw(); } }, "Desk"),
      el("h1", { class: "grow" }, session.title),
      el("span", { class: `pill ${session.state}` }, stateLabel(session.state)),
    ),
    session.detail || session.changes ? el("p", { class: "small muted" }, [session.detail, session.changes].filter(Boolean).join(" · ")) : null,
    el("pre", { class: "screen" }, session.screen || "Nothing on screen yet."),
    el(
      "div",
      { class: "card stack" },
      prompt,
      nudges.length ? el("div", { class: "actions" }, ...nudges) : null,
      el(
        "div",
        { class: "actions" },
        el("button", { class: "btn", type: "button", disabled: busy || !session.canSend, onclick: () => void sendText(prompt.value, false) }, busy ? "Sending…" : "Send"),
        session.canStop
          ? el("button", { class: "ghost", type: "button", disabled: busy, onclick: () => void stopSession() }, "Stop")
          : null,
      ),
    ),
  );
}

async function sendText(text, force) {
  const words = text.trim();
  if (!words || !session) return;
  if (session.state === "working" && !force && !window.confirm("Still working. Send anyway?")) return;
  await withBusy(async () => {
    if (session.ptyId && session.state !== "done") {
      try {
        await call("/api/send", { method: "POST", body: JSON.stringify({ ptyId: session.ptyId, text: words, force: force || session.state === "working" }) });
      } catch (err) {
        if (err.working && !force) {
          if (!window.confirm("Still working. Send anyway?")) return;
          await call("/api/send", { method: "POST", body: JSON.stringify({ ptyId: session.ptyId, text: words, force: true }) });
          return;
        }
        throw err;
      }
      return;
    }
    const result = await call("/api/continue", { method: "POST", body: JSON.stringify({ runId: session.runId, text: words }) });
    sessionQuery = { ptyId: result.ptyId, runId: result.runId };
  }, true);
}

async function stopSession() {
  if (!session?.ptyId || !window.confirm("Stop this session?")) return;
  await withBusy(() => call("/api/stop", { method: "POST", body: JSON.stringify({ ptyId: session.ptyId }) }));
}

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.addEventListener("message", (event) => {
    if (event.data?.type !== "open") return;
    sessionQuery = { ptyId: event.data.ptyId || "", runId: event.data.runId || "" };
    view = sessionQuery.ptyId || sessionQuery.runId ? "session" : "desk";
    void refresh();
  });
  void navigator.serviceWorker.register("/sw.js");
}

draw();
if (token) {
  schedule();
  void refresh();
}
