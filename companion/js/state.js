// @ts-check
// What the page's modules share: what the phone keeps, what the computer last said, and the nodes
// of the page on show. The shapes come from the desktop's own types, for checking only: nothing
// from src/ reaches the phone.

/** @typedef {import("../../src/core/companion.js").DeskPayload} DeskPayload */
/** @typedef {import("../../src/core/companion.js").DeskWorkspace} DeskWorkspace */
/** @typedef {import("../../src/core/companion.js").DeskSession} DeskSession */
/** @typedef {import("../../src/core/companion-http.js").SessionPayload} SessionPayload */
/** @typedef {import("../../src/core/companion-orchestrator.js").PhoneOrchestrator} PhoneOrchestrator */
/** @typedef {import("../../src/core/companion-orchestrator.js").PhoneTurn} PhoneTurn */
/** @typedef {import("../../src/core/companion-orchestrator.js").PhoneStep} PhoneStep */
/** @typedef {import("../../src/core/companion-orchestrator.js").PhoneRunning} PhoneRunning */
/** @typedef {import("../../src/core/plans.js").PlanSummary} PlanSummary */
/** @typedef {import("../../src/core/plans.js").PlanProvider} PlanProvider */
/** @typedef {"pair" | "home" | "desk" | "launch" | "session" | "maestro"} View */
/** @typedef {{ ptyId: string, runId: string }} SessionQuery */
/** A panel over the page (`sheet` in dom.js). @typedef {HTMLDivElement & { open: () => void }} Sheet */

export const TOKEN_KEY = "vibeforge-phone";
export const PLANS_KEY = "vibeforge-plans-open";
export const RUNS_KEY = "vibeforge-runs-open";
export const INSTALL_KEY = "vibeforge-install-dismissed";
/** Chosen on the landing page. Absent buzz keeps an already-allowed notification. Absent tuck keeps finished work closed. */
export const BUZZ_KEY = "vibeforge-buzz";
export const TUCK_KEY = "vibeforge-tuck-finished";
export const TEXT_KEY = "vibeforge-large-text";

const token = localStorage.getItem(TOKEN_KEY) || "";

/**
 * @typedef {object} State
 * @property {string} token
 * @property {View} view
 * @property {DeskPayload | null} desk
 * @property {SessionPayload | null} session
 * @property {SessionQuery} sessionQuery
 * @property {string} error What the last poll ran into: the computer offline, or a session that has gone. The next poll replaces it.
 * @property {string} actionError What an action someone tapped ran into. It stays until the next action, or until it is tapped away.
 * @property {boolean} busy
 * @property {number} ticket
 * @property {PlanSummary | null} plans
 * @property {PhoneOrchestrator | null} orch The Orchestrator as the page last read it (GET /api/orchestrator).
 * @property {string} orchDraft What is typed or dictated for the Orchestrator, kept while the page shows something else.
 */

/** @type {State} */
export const state = {
  token,
  /** A paired phone opens here. Enter reaches the desk; the name on the desk comes back. */
  view: token ? "home" : "pair",
  desk: null,
  session: null,
  sessionQuery: { ptyId: "", runId: "" },
  error: "",
  actionError: "",
  busy: false,
  ticket: 0,
  plans: null,
  orch: null,
  orchDraft: "",
};

/**
 * The nodes of the page on show that a poll updates in place. Inputs are never rebuilt by a poll.
 * Each page fills in its own: the rest belong to other pages and are not there.
 * @typedef {object} Parts
 * @property {HTMLDivElement} banner
 * @property {HTMLSpanElement} bannerText
 * @property {HTMLButtonElement} bannerClose
 * @property {HTMLButtonElement} pair
 * @property {HTMLParagraphElement} buzzNote
 * @property {HTMLButtonElement} buzz
 * @property {HTMLDivElement} plans
 * @property {string | null} plansKey
 * @property {HTMLDivElement} list
 * @property {string | null} listKey
 * @property {HTMLButtonElement} start
 * @property {HTMLHeadingElement} title
 * @property {HTMLSpanElement} px
 * @property {HTMLSpanElement} pill
 * @property {HTMLParagraphElement} meta
 * @property {HTMLPreElement} screen
 * @property {boolean} stick
 * @property {HTMLTextAreaElement} prompt
 * @property {HTMLButtonElement} send
 * @property {HTMLButtonElement} stop
 * @property {Map<string, { key: string, node: HTMLElement }>} orchTurns
 * @property {string | null} orchTurnsKey
 * @property {HTMLSelectElement} planner
 * @property {string | null} plannerKey
 * @property {HTMLButtonElement[]} modes
 * @property {HTMLButtonElement} newTalk
 * @property {HTMLButtonElement} runningOpen
 * @property {HTMLDivElement} runningList
 * @property {string | null} runningKey
 * @property {Sheet} runningSheet
 * @property {HTMLParagraphElement} orchLoading
 * @property {HTMLParagraphElement} earlier
 * @property {HTMLParagraphElement} startBody
 * @property {HTMLDivElement} startHere
 * @property {HTMLDivElement} notReady
 * @property {HTMLDivElement} turnList
 * @property {HTMLSpanElement} thinkingText
 * @property {HTMLButtonElement} thinkingStop
 * @property {HTMLDivElement} thinking
 * @property {HTMLDivElement} turns
 * @property {boolean} stickTurns
 * @property {HTMLTextAreaElement} box
 * @property {HTMLSpanElement} micMeter
 * @property {HTMLSpanElement} micBusy
 * @property {HTMLElement} micWord
 * @property {HTMLSpanElement} micClock
 * @property {HTMLSpanElement} micHint
 * @property {HTMLButtonElement} micCancel
 * @property {HTMLDivElement} micNote
 * @property {HTMLButtonElement} mic
 * @property {HTMLButtonElement} say
 */

/** Replaced whole each time a page is built (`show`), so nothing of the page before lingers. */
export let parts = /** @type {Parts} */ ({});

/** @param {Parts} next */
export function setParts(next) {
  parts = next;
}

/** Off is stored. No choice buzzes only when the phone already allowed it, so an existing buzz keeps going. */
export function buzzWanted() {
  const saved = localStorage.getItem(BUZZ_KEY);
  if (saved === "0") return false;
  if (saved === "1") return true;
  return typeof Notification !== "undefined" && Notification.permission === "granted";
}

export function buzzShownOn() {
  return buzzWanted() && typeof Notification !== "undefined" && Notification.permission === "granted";
}

export function textLarge() {
  return localStorage.getItem(TEXT_KEY) === "1";
}

/** Finished-only projects start closed, unless the landing page said to leave them open. */
export function tuckFinished() {
  return localStorage.getItem(TUCK_KEY) !== "0";
}

export function plansOpen() {
  return localStorage.getItem(PLANS_KEY) === "1";
}
