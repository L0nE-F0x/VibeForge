// @ts-check
// Starting someone in a workspace, and one session close up: its screen, the next instruction,
// and Stop.

import { post, withBusy } from "./api.js";
import { el } from "./dom.js";
import { setView } from "./pages.js";
import { parts, state } from "./state.js";
import { stateLabel, t } from "./words.js";

/** @typedef {import("./state.js").SessionQuery} SessionQuery */
/** @typedef {import("./state.js").View} View */

/** Where a session's Back goes: the desk, or the Orchestrator it was opened from. @type {View} */
let sessionBack = "desk";
let launchWorkspace = "";

/** @param {SessionQuery} query */
export function openSession(query) {
  state.sessionQuery = query;
  state.session = null;
  sessionBack = state.view === "maestro" ? "maestro" : "desk";
  setView(query.ptyId || query.runId ? "session" : sessionBack);
}

/** @param {string} workspaceId */
export function openLaunch(workspaceId) {
  launchWorkspace = workspaceId;
  setView("launch");
}

/** Agents allowed in the workspace, then each CLI on its own. Values are "agent:<id>" or "engine:<id>". */
function launchChoices() {
  const agents = (state.desk?.agents ?? []).filter((agent) => agent.workspaceIds.includes(launchWorkspace));
  const engines = state.desk?.engines ?? [];
  return { agents, engines };
}

export function launchPage() {
  const workspace = (state.desk?.workspaces ?? []).find((item) => item.id === launchWorkspace);
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

export function updateLaunch() {
  if (!parts.start) return;
  parts.start.disabled = state.busy;
  parts.start.textContent = state.busy ? t("phone.starting") : t("phone.start");
}

/**
 * @param {string} choice
 * @param {HTMLTextAreaElement} box
 */
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

export function sessionPage() {
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
    el("div", { class: "top" }, el("button", { class: "back", type: "button", onclick: () => { state.session = null; setView(sessionBack); } }, t("phone.back")), parts.title, parts.px, parts.pill),
    parts.meta,
    parts.screen,
    el("div", { class: "card stack composer" }, parts.prompt, el("div", { class: "actions" }, parts.send, parts.stop)),
  );
}

export function updateSession() {
  parts.send.disabled = state.busy || !state.session?.canSend;
  parts.send.textContent = state.busy ? t("phone.sending") : t("phone.send");
  if (!state.session) return;
  parts.title.textContent = state.session.title;
  parts.px.hidden = false;
  parts.px.className = `px ${state.session.state}`;
  parts.pill.hidden = false;
  parts.pill.className = `pill ${state.session.state}`;
  parts.pill.textContent = stateLabel(state.session.state);
  parts.screen.className = `screen ${state.session.state}`;
  const meta = [state.session.detail, state.session.changes].filter(Boolean).join(" · ");
  parts.meta.hidden = !meta;
  parts.meta.textContent = meta;
  parts.prompt.placeholder = state.session.state === "done" ? t("phone.nextDone") : t("phone.next");
  parts.stop.hidden = !state.session.stop;
  parts.stop.disabled = state.busy;
  parts.stop.textContent = state.session.stop === "interrupt" ? t("phone.interrupt") : t("phone.stop");
  const screen = state.session.screen || t("phone.emptyScreen");
  if (parts.screen.textContent !== screen) {
    parts.screen.textContent = screen;
    if (parts.stick) parts.screen.scrollTop = parts.screen.scrollHeight;
  }
}

/**
 * Sends the next instruction, and clears the box once it has gone through.
 * @param {string} text
 */
async function sendText(text) {
  const words = text.trim();
  if (!words || !state.session) return;
  let force = false;
  if (state.session.state === "working") {
    if (!window.confirm(t("phone.sendAnyway"))) return;
    force = true;
  }
  const query = { ptyId: state.session.ptyId || "", runId: state.session.runId || "" };
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
    state.sessionQuery = { ptyId: result.ptyId || "", runId: result.runId || query.runId };
    parts.stick = true;
    return true;
  });
  if (sent && parts.prompt) parts.prompt.value = "";
}

async function stopSession() {
  if (!state.session?.ptyId) return;
  const ask = state.session.stop === "interrupt" ? t("phone.askInterrupt") : t("phone.askStop");
  if (!window.confirm(ask)) return;
  const ptyId = state.session.ptyId;
  await withBusy(() => post("/api/stop", { ptyId }));
}
