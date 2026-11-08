// @ts-check
// The desktop's Orchestrator view on the phone (src/ui/views/Orchestrator.tsx): the same
// conversation, plan cards and Running list, read from and sent to the computer. The planning CLI
// runs there; the page only shows what it said and passes on what the person says and taps.

import { post, withBusy } from "./api.js";
import { brandMark } from "./art.js";
import { editingIn, el, sheet } from "./dom.js";
import { micParts, paintMic } from "./mic.js";
import { setView } from "./pages.js";
import { pendingSteps, planCard, sizePrompts } from "./plan-card.js";
import { openSession } from "./session.js";
import { parts, state } from "./state.js";
import { stateLabel, t, tCount } from "./words.js";

/** @typedef {import("./state.js").PhoneOrchestrator} PhoneOrchestrator */
/** @typedef {import("./state.js").PhoneTurn} PhoneTurn */
/** @typedef {import("./state.js").PhoneRunning} PhoneRunning */

/** @param {string | null | undefined} id */
export function engineLabel(id) {
  return state.orch?.engines.find((engine) => engine.id === id)?.label || id || "";
}

export function maestroPage() {
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
  parts.box.value = state.orchDraft;
  parts.box.addEventListener("input", () => {
    state.orchDraft = parts.box.value;
  });
  micParts();
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

export function whoMark() {
  return el("span", { class: "orch-who", "aria-hidden": "true" }, brandMark());
}

export function updateMaestro() {
  if (!parts.turns) return;
  const orch = state.orch;
  paintPlanner();
  for (const button of parts.modes) {
    const on = orch?.mode === button.dataset.mode;
    button.classList.toggle("on", on);
    button.setAttribute("aria-pressed", String(on));
    button.disabled = state.busy || !orch;
  }
  parts.newTalk.disabled = state.busy || !orch?.turns.length;
  paintRunning();
  parts.orchLoading.hidden = Boolean(orch);
  parts.say.disabled = state.busy || !orch || orch.thinking;
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
  parts.thinkingStop.disabled = state.busy;
  for (const button of /** @type {NodeListOf<HTMLButtonElement>} */ (parts.turnList.querySelectorAll("button[data-act]"))) button.disabled = state.busy || button.dataset.off === "1";
  const key = JSON.stringify([changed, orch.turns.length, orch.thinking, orch.engineReady]);
  if (key !== parts.orchTurnsKey) {
    parts.orchTurnsKey = key;
    if (parts.stickTurns && !editingIn(parts.turns)) parts.turns.scrollTop = parts.turns.scrollHeight;
  }
}

/** The planner list, rebuilt only when it changes and never while it is open. */
function paintPlanner() {
  const select = parts.planner;
  const orch = state.orch;
  select.disabled = state.busy || !orch;
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
  const orch = /** @type {PhoneOrchestrator} */ (state.orch);
  // A plan card names CLIs, workspaces and running terminals, so it is redrawn when those change.
  const context = JSON.stringify([orch.engines, orch.workspaces, orch.running.map((item) => [item.ptyId, item.label]), [...pendingSteps]]);
  const seen = new Set();
  /** @type {HTMLElement | null} */
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
    /** @type {ChildNode | null} */
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

/** @param {PhoneTurn} turn */
function turnNode(turn) {
  if (turn.from === "you") return el("div", { class: "orch-turn from-you" }, el("span", { class: "orch-said" }, turn.text));
  const orch = /** @type {PhoneOrchestrator} */ (state.orch);
  const label = engineLabel(turn.by || orch.engineId);
  const said = turn.problem
    ? el("div", { class: "orch-problem-text" }, el("span", {}, t(`orch.problem.${turn.problem}`, { engine: label })), turn.detail ? el("span", { class: "orch-detail" }, turn.detail) : null)
    : turn.text
      ? el("span", { class: "orch-said" }, turn.text)
      : null;
  return el("div", { class: "orch-turn from-vibeforge" }, whoMark(), el("div", { class: "orch-body" }, said, turn.steps ? planCard(turn) : null));
}

async function askOrch() {
  const said = parts.box.value.trim();
  if (!said || !state.orch || state.orch.thinking) return;
  parts.stickTurns = true;
  const sent = await withBusy(async () => {
    await post("/api/orchestrator/ask", { text: said });
    return true;
  });
  if (!sent) return;
  state.orchDraft = "";
  if (parts.box) parts.box.value = "";
}

function stopThinking() {
  return withBusy(() => post("/api/orchestrator/stop", {}));
}

function newTalk() {
  return withBusy(() => post("/api/orchestrator/new", {}));
}

/** @param {{ engine?: string, mode?: string }} patch */
function saveOrch(patch) {
  return withBusy(() => post("/api/orchestrator/settings", patch));
}

/** "Running · 3": every coding CLI on the computer, the Orchestrator's first. The list opens over the page. */
function paintRunning() {
  const running = state.orch?.running ?? [];
  const own = running.filter((item) => item.orchestrated);
  parts.runningOpen.hidden = running.length === 0;
  const key = JSON.stringify([running, state.busy]);
  if (key === parts.runningKey) return;
  parts.runningKey = key;
  const lit = running.some((item) => item.state === "working") ? "working" : "waiting";
  parts.runningOpen.replaceChildren(
    .../** @type {HTMLElement[]} */ ([
      el("span", { class: `px ${lit}`, "aria-hidden": "true" }),
      el("span", { class: "grow" }, `${t("orch.team")} · ${running.length}`),
      own.length ? el("span", { class: "small faint" }, `${t("orch.mine")} · ${own.length}`) : null,
      el("span", { class: "chev", "aria-hidden": "true" }),
    ].filter(Boolean)),
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
      el("button", { class: "ghost small-btn", type: "button", disabled: state.busy, onclick: () => void stopOne(item) }, item.stop === "interrupt" ? t("phone.interrupt") : t("orch.stopOne")),
    ),
  );
  parts.runningList.replaceChildren(
    .../** @type {HTMLElement[]} */ ([
      own.length ? el("div", { class: "orch-team-head" }, el("button", { class: "ghost danger", type: "button", disabled: state.busy, onclick: () => void stopAll(own) }, t("orch.stopAll"))) : null,
      running.length ? null : el("p", { class: "small faint" }, t("orch.teamEmpty")),
      ...rows,
    ].filter(Boolean)),
  );
}

/**
 * Stop as the phone stops: a run's terminal closes; a CLI typed into a shell is interrupted and the shell stays.
 * @param {PhoneRunning} item
 */
async function stopOne(item) {
  if (!window.confirm(item.stop === "interrupt" ? t("phone.askInterrupt") : t("phone.askStop"))) return;
  await withBusy(() => post("/api/stop", { ptyId: item.ptyId }));
}

/**
 * Stop all: only the CLIs the Orchestrator started, as on the desktop, which asks first too.
 * @param {PhoneRunning[]} own
 */
async function stopAll(own) {
  if (!window.confirm(`${tCount("orch.stopAllTitle", own.length)}\n\n${t("orch.stopAllBody")}`)) return;
  await withBusy(() => Promise.all(own.map((item) => post("/api/stop", { ptyId: item.ptyId }))));
}
