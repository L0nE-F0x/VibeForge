// @ts-check
// A plan's card in the Orchestrator's conversation: its steps, fixed on the card before Go, then
// Go or Cancel, and what each step did.

import { post, refresh, withBusy } from "./api.js";
import { glyph } from "./art.js";
import { el } from "./dom.js";
import { engineLabel } from "./maestro.js";
import { openSession } from "./session.js";
import { parts, state } from "./state.js";
import { t, tCount } from "./words.js";

/** @typedef {import("./state.js").PhoneOrchestrator} PhoneOrchestrator */
/** @typedef {import("./state.js").PhoneTurn} PhoneTurn */
/** @typedef {import("./state.js").PhoneStep} PhoneStep */
/** A step's fields as the phone changes them (StepPatch in src/core/companion-http.ts). @typedef {Record<string, string>} StepPatch */
/** @typedef {HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement} Field */

/** A step's changes on their way to the computer, by step id, so a poll in between doesn't put the old words back. @type {Map<string, StepPatch>} */
export const pendingSteps = new Map();
/** Step changes go one after another, and Go waits for them. @type {Promise<unknown>} */
let stepQueue = Promise.resolve();

/** @type {Record<string, string>} */
const ISSUE_KEYS = { workspace: "orch.issue.workspace", engine: "orch.issue.engine", engineMissing: "orch.issue.engineMissing", target: "orch.issue.target", prompt: "orch.issue.prompt" };
/** @type {Record<string, string>} */
const PLAN_TONE = { waiting: "waiting", running: "working", done: "done", cancelled: "done", replaced: "done" };

/** @param {PhoneTurn} turn */
export function planCard(turn) {
  const steps = turn.steps || [];
  const plan = turn.plan || "done";
  const waiting = plan === "waiting";
  const blocked = waiting ? steps.filter((step) => step.issue).length : 0;
  const card = el(
    "div",
    { class: `orch-plan state-${plan}` },
    el("div", { class: "orch-plan-head" }, el("span", { class: `chip ${PLAN_TONE[plan] || "done"}` }, t(`orch.plan.${plan}`)), el("span", { class: "small faint" }, tCount("orch.steps", steps.length))),
    steps.map((step) => stepNode(turn, step, waiting)),
  );
  if (waiting) {
    const note = blocked > 0 && blocked < steps.length ? tCount("orch.skipNote", blocked) : blocked === steps.length ? t("orch.fixFirst") : "";
    card.append(
      el(
        "div",
        { class: "orch-plan-foot" },
        el("span", { class: "small faint grow" }, note),
        el("button", { class: "ghost", type: "button", "data-act": "cancel", disabled: state.busy, onclick: () => void cancelPlan(turn, card) }, t("common.cancel")),
        el("button", { class: "btn", type: "button", "data-act": "go", "data-off": blocked === steps.length ? "1" : "0", disabled: state.busy || blocked === steps.length, onclick: () => void goPlan(turn, card) }, t("orch.go")),
      ),
    );
  }
  return card;
}

/**
 * @param {PhoneTurn} turn
 * @param {PhoneStep} step
 * @param {boolean} editable
 */
function stepNode(turn, step, editable) {
  const orch = /** @type {PhoneOrchestrator} */ (state.orch);
  const pending = pendingSteps.get(step.id) || {};
  /** @param {string} key */
  const value = (key) => (key in pending ? pending[key] : /** @type {Record<string, any>} */ (step)[key]);
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
          { class: "ghost small-btn", type: "button", "data-act": "open", "data-off": step.live ? "0" : "1", disabled: state.busy || !step.live, onclick: () => openSession({ ptyId: /** @type {string} */ (step.ptyId), runId: step.runId || "" }) },
          t("phone.orchOpen"),
        ),
      ),
    );
  }
  const remove = editable
    ? el("button", { class: "ghost orch-step-x", type: "button", "data-act": "remove", "aria-label": t("orch.removeStep"), title: t("orch.removeStep"), disabled: state.busy, onclick: () => void removeStep(turn, step) }, glyph("remove"))
    : null;
  return el("div", { class: `orch-step step-${step.state}${step.issue ? " has-issue" : ""}`, "data-step": step.id }, el("span", { class: "orch-step-icon" }, icon), main, remove);
}

/**
 * Every CLI, the ones not on the computer's PATH greyed out (EnginePick on the desktop).
 * @param {PhoneTurn} turn
 * @param {PhoneStep} step
 * @param {string} value
 */
function enginePick(turn, step, value) {
  const engines = /** @type {PhoneOrchestrator} */ (state.orch).engines;
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

/**
 * @param {PhoneTurn} turn
 * @param {PhoneStep} step
 * @param {string} value
 */
function workspacePick(turn, step, value) {
  const workspaces = /** @type {PhoneOrchestrator} */ (state.orch).workspaces;
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

/**
 * The new branch, in its own copy of the workspace. Empty: no copy (a folder that isn't a git repository).
 * @param {PhoneTurn} turn
 * @param {PhoneStep} step
 * @param {string} value
 */
function branchField(turn, step, value) {
  const input = el("input", { class: "orch-branch-input", "data-field": "branch", autocapitalize: "off", autocorrect: "off", spellcheck: "false", placeholder: t("orch.noBranch"), "aria-label": t("orch.branch") });
  input.value = value;
  input.addEventListener("blur", () => {
    const next = input.value.trim();
    if (next !== currentStep(step, "branch")) editStep(turn, step, { branch: next });
  });
  return el("label", { class: "orch-branch", title: t("orch.branchTip") }, glyph("branch"), input);
}

/**
 * What it is asked to do, as tall as its words (up to a point), so the whole instruction reads before Go.
 * @param {PhoneTurn} turn
 * @param {PhoneStep} step
 * @param {string} value
 */
function promptField(turn, step, value) {
  const box = el("textarea", { class: "orch-prompt", "data-field": "prompt", "aria-label": t("orch.prompt") });
  box.value = value;
  box.addEventListener("input", () => sizePrompt(box));
  box.addEventListener("blur", () => {
    if (box.value !== currentStep(step, "prompt")) editStep(turn, step, { prompt: box.value });
  });
  return box;
}

/** @param {HTMLTextAreaElement} box */
function sizePrompt(box) {
  box.style.height = "0px";
  box.style.height = `${Math.min(240, Math.max(44, box.scrollHeight + 2))}px`;
}

/** @param {HTMLElement} node */
export function sizePrompts(node) {
  for (const box of /** @type {NodeListOf<HTMLTextAreaElement>} */ (node.querySelectorAll("textarea.orch-prompt"))) sizePrompt(box);
}

/**
 * A step's field as the computer will have it once the changes on their way have landed.
 * @param {PhoneStep} step
 * @param {string} key
 */
function currentStep(step, key) {
  const pending = pendingSteps.get(step.id);
  return pending && key in pending ? pending[key] : /** @type {Record<string, any>} */ (step)[key];
}

/**
 * A change made on the card before Go, sent at once. A poll before it lands shows it too.
 * @param {PhoneTurn} turn
 * @param {PhoneStep} step
 * @param {StepPatch} patch
 */
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
      state.error = err.message;
    })
    .finally(() => {
      if (pendingSteps.get(step.id) === pending) pendingSteps.delete(step.id);
      void refresh();
    });
  return sent;
}

/**
 * Whatever is typed on the card and not sent yet: iOS doesn't always take the focus off a box when Go is tapped.
 * @param {PhoneTurn} turn
 * @param {HTMLElement} card
 */
function flushStepEdits(turn, card) {
  for (const step of turn.steps || []) {
    const row = [.../** @type {NodeListOf<HTMLElement>} */ (card.querySelectorAll("[data-step]"))].find((node) => node.dataset.step === step.id);
    if (!row) continue;
    /** @type {StepPatch} */
    const patch = {};
    for (const field of /** @type {NodeListOf<Field>} */ (row.querySelectorAll("[data-field]"))) {
      const key = /** @type {string} */ (field.dataset.field);
      const next = key === "branch" ? field.value.trim() : field.value;
      if (next !== currentStep(step, key)) patch[key] = next;
    }
    if (Object.keys(patch).length) editStep(turn, step, patch);
  }
}

/**
 * Done with the card: what was typed on it is sent, and the box lets go so the card can show what happens next.
 * @param {PhoneTurn} turn
 * @param {HTMLElement} card
 */
function leaveCard(turn, card) {
  flushStepEdits(turn, card);
  if (card.contains(document.activeElement)) /** @type {HTMLElement} */ (document.activeElement).blur();
}

/**
 * @param {PhoneTurn} turn
 * @param {HTMLElement} card
 */
async function goPlan(turn, card) {
  leaveCard(turn, card);
  parts.stickTurns = true;
  await withBusy(async () => {
    await stepQueue;
    await post("/api/orchestrator/go", { turnId: turn.id });
    return true;
  });
}

/**
 * @param {PhoneTurn} turn
 * @param {HTMLElement} card
 */
function cancelPlan(turn, card) {
  if (card.contains(document.activeElement)) /** @type {HTMLElement} */ (document.activeElement).blur();
  return withBusy(() => post("/api/orchestrator/cancel", { turnId: turn.id }));
}

/**
 * @param {PhoneTurn} turn
 * @param {PhoneStep} step
 */
function removeStep(turn, step) {
  if (document.activeElement?.closest?.(".orch-plan")) /** @type {HTMLElement} */ (document.activeElement).blur();
  return withBusy(() => post("/api/orchestrator/remove", { turnId: turn.id, stepId: step.id }));
}
