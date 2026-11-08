// @ts-check
// The desk: every workspace with who is working, waiting or finished in it, and the plan limits
// above them.

import { brandMark, planMark, wordmark } from "./art.js";
import { bar, el } from "./dom.js";
import { setView, update } from "./pages.js";
import { openLaunch, openSession } from "./session.js";
import { BUZZ_KEY, PLANS_KEY, parts, plansOpen, RUNS_KEY, state, tuckFinished } from "./state.js";
import { ago, language, span, stateLabel, t } from "./words.js";

/** @typedef {import("./state.js").DeskWorkspace} DeskWorkspace */
/** @typedef {import("./state.js").DeskSession} DeskSession */
/** @typedef {import("./state.js").PlanSummary} PlanSummary */

/** @type {Record<string, string>} */
const PLAN_NAMES = { claude: "Claude", codex: "Codex", grok: "Grok", agy: "Gemini", kimi: "Kimi", muse: "Muse" };

/** The mark and the name, as one button back to the landing page. */
function deskWordmark() {
  return el(
    "button",
    { class: "wordmark-home", type: "button", "aria-label": t("phone.homeMark"), onclick: () => setView("home") },
    brandMark(),
    wordmark(),
  );
}

export function deskPage() {
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

export function updateDesk() {
  const ask = typeof Notification !== "undefined" && Notification.permission === "default" && localStorage.getItem(BUZZ_KEY) !== "0";
  parts.buzz.hidden = !ask;
  const plansKey = JSON.stringify([state.plans, Math.floor(Date.now() / 60000)]);
  if (plansKey !== parts.plansKey) {
    parts.plansKey = plansKey;
    parts.plans.replaceChildren(...(state.plans?.providers?.length ? [plansCard(state.plans)] : []));
  }
  if (!state.desk) return;
  // The list has no inputs, so it is redrawn whole, but only when something on it changed (or a minute passed).
  const key = JSON.stringify([state.desk.workspaces, Math.floor(Date.now() / 60000)]);
  if (key === parts.listKey) return;
  parts.listKey = key;
  parts.list.replaceChildren(
    ...(state.desk.workspaces.length ? state.desk.workspaces.map((workspace) => workspaceCard(workspace)) : [el("div", { class: "card muted" }, t("phone.noWorkspaces"))]),
  );
}

/** @returns {Record<string, string>} */
function readRuns() {
  try {
    const value = JSON.parse(localStorage.getItem(RUNS_KEY) || "{}");
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

/**
 * A workspace with someone working or waiting starts open. One that is only finished starts hidden. A saved Show or Hide wins, and the landing page can leave finished work open.
 * @param {DeskWorkspace} workspace
 */
function runsAreOpen(workspace) {
  const saved = readRuns()[workspace.id || "elsewhere"];
  if (saved === "0") return false;
  if (saved === "1") return true;
  if (!tuckFinished()) return true;
  return workspace.sessions.some((item) => item.state === "working" || item.state === "waiting");
}

/** @param {DeskWorkspace} workspace */
function workspaceCard(workspace) {
  const key = workspace.id || "elsewhere";
  const hasSessions = workspace.sessions.length > 0;
  const open = !hasSessions || runsAreOpen(workspace);
  const start = workspace.id ? el("button", { class: "ghost", type: "button", onclick: () => openLaunch(workspace.id) }, t("phone.start")) : null;
  /** @type {HTMLButtonElement | null} */
  const toggle = hasSessions
    ? el(
        "button",
        {
          class: "ghost runs-toggle",
          type: "button",
          "aria-expanded": String(open),
          onclick: () => {
            const button = /** @type {HTMLButtonElement} */ (toggle);
            const next = button.getAttribute("aria-expanded") !== "true";
            const saved = readRuns();
            saved[key] = next ? "1" : "0";
            localStorage.setItem(RUNS_KEY, JSON.stringify(saved));
            button.closest(".workspace")?.classList.toggle("collapsed", !next);
            button.textContent = next ? t("phone.plansHide") : t("phone.plansShow");
            button.setAttribute("aria-expanded", String(next));
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

/** @param {DeskSession} item */
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

/** @param {number | null | undefined} percent */
function level(percent) {
  if (percent === null || percent === undefined || percent < 80) return "quiet";
  return percent < 100 ? "warm" : "full";
}

/**
 * Plan limits, as the desktop's live popover shows them: each plan's busiest window first. Closed until opened.
 * @param {PlanSummary} summary
 */
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
      const credits = /** @type {number} */ (provider.credits) > 0
        ? t("plans.credits", { amount: new Intl.NumberFormat(language, { style: "currency", currency: "USD" }).format(/** @type {number} */ (provider.credits)) })
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
