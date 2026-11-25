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
/** @typedef {import("../../src/core/orchestrator.js").OrchestratorThreadSummary} ThreadSummary */
/** @typedef {import("../../src/core/orchestrator.js").OrchestratorCheck} OrchCheck */
/** @typedef {import("../../src/core/plans.js").PlanSummary} PlanSummary */
/** @typedef {import("../../src/core/plans.js").PlanProvider} PlanProvider */
/** @typedef {"pair" | "home" | "desk" | "launch" | "session" | "maestro" | "computers"} View */
/**
 * A computer this phone shows. `url` is where its page is ("https://laptop.tail1234.ts.net"), and
 * empty for the one this page was loaded from. `token` is its pairing code, empty until it is given.
 * @typedef {{ url: string, token: string, name: string }} Computer
 */
/** @typedef {{ ptyId: string, runId: string }} SessionQuery */
/** A panel over the page (`sheet` in dom.js). @typedef {HTMLDivElement & { open: () => void }} Sheet */

/** The pairing code of the computer this page was loaded from. */
export const TOKEN_KEY = "vibeforge-phone";
/** What that computer calls itself, once it has said. */
export const NAME_KEY = "vibeforge-computer-name";
/** The other computers this phone shows, and the address of the one on show (empty: the one this page came from). */
export const COMPUTERS_KEY = "vibeforge-computers";
export const COMPUTER_KEY = "vibeforge-computer";
export const PLANS_KEY = "vibeforge-plans-open";
export const RUNS_KEY = "vibeforge-runs-open";
export const INSTALL_KEY = "vibeforge-install-dismissed";
/** Chosen on the landing page. Absent buzz keeps an already-allowed notification. Absent tuck keeps finished work closed. */
export const BUZZ_KEY = "vibeforge-buzz";
export const TUCK_KEY = "vibeforge-tuck-finished";
export const TEXT_KEY = "vibeforge-large-text";

/** @returns {Computer[]} */
function otherComputers() {
  try {
    const saved = JSON.parse(localStorage.getItem(COMPUTERS_KEY) || "[]");
    if (!Array.isArray(saved)) return [];
    return saved
      .filter((item) => item && typeof item.url === "string" && item.url)
      .map((item) => ({ url: item.url, token: typeof item.token === "string" ? item.token : "", name: typeof item.name === "string" ? item.name : "" }));
  } catch {
    return [];
  }
}

/** Every computer this phone shows: the one the page came from first, then the ones added. @returns {Computer[]} */
export function computers() {
  return [{ url: "", token: localStorage.getItem(TOKEN_KEY) || "", name: localStorage.getItem(NAME_KEY) || "" }, ...otherComputers()];
}

/**
 * Keeps a computer: a new one, or a new code or name for one already here.
 * @param {Computer} computer
 */
export function saveComputer(computer) {
  if (!computer.url) {
    if (computer.token) localStorage.setItem(TOKEN_KEY, computer.token);
    else localStorage.removeItem(TOKEN_KEY);
    if (computer.name) localStorage.setItem(NAME_KEY, computer.name);
    return;
  }
  const rest = otherComputers().filter((item) => item.url !== computer.url);
  const at = otherComputers().findIndex((item) => item.url === computer.url);
  rest.splice(at < 0 ? rest.length : at, 0, { url: computer.url, token: computer.token, name: computer.name });
  localStorage.setItem(COMPUTERS_KEY, JSON.stringify(rest));
}

/**
 * What a computer calls itself, as it just said: kept, so the list of computers reads by name.
 * @param {string} url
 * @param {unknown} name
 */
export function nameComputer(url, name) {
  if (typeof name !== "string" || !name.trim()) return;
  const found = computers().find((item) => item.url === url);
  if (found && found.name !== name.trim()) saveComputer({ ...found, name: name.trim().slice(0, 80) });
}

/**
 * Takes an added computer off this phone. The one the page came from stays: it only loses its code.
 * @param {string} url
 */
export function removeComputer(url) {
  if (!url) return;
  localStorage.setItem(COMPUTERS_KEY, JSON.stringify(otherComputers().filter((item) => item.url !== url)));
}

/**
 * What to call a computer: its own name, else the first part of its address ("laptop" of laptop.tail1234.ts.net).
 * @param {Computer} computer
 */
export function computerLabel(computer) {
  if (computer.name) return computer.name;
  try {
    const host = computer.url ? new URL(computer.url).hostname : window.location.hostname;
    return /^[\d.]+$/.test(host) || host === "localhost" ? host : host.split(".")[0];
  } catch {
    return computer.url;
  }
}

/** The one on show: the one last chosen, while it is still here. */
const shown = computers().find((item) => item.url === (localStorage.getItem(COMPUTER_KEY) || "")) || computers()[0];
const token = shown.token;

/**
 * @typedef {object} State
 * @property {string} base Where the computer on show answers: empty for the one this page came from, else its address.
 * @property {string} token The pairing code of the computer on show.
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
 * @property {string[]} orchImages Pasted or picked image data URLs queued with the next Orchestrator message.
 * @property {string} focusTurn A plan a link asked to see (`?turn=`): brought into view once the Orchestrator shows it.
 */

/** @type {State} */
export const state = {
  base: shown.url,
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
  orchImages: [],
  focusTurn: "",
};

/**
 * The nodes of the page on show that a poll updates in place. Inputs are never rebuilt by a poll.
 * Each page fills in its own: the rest belong to other pages and are not there.
 * @typedef {object} Parts
 * @property {HTMLDivElement} banner
 * @property {HTMLSpanElement} bannerText
 * @property {HTMLButtonElement} bannerClose
 * @property {HTMLButtonElement} pair
 * @property {HTMLButtonElement} addComputer
 * @property {HTMLParagraphElement} addNote
 * @property {HTMLDivElement} computerList
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
 * @property {HTMLButtonElement} threadsOpen
 * @property {HTMLDivElement} threadsList
 * @property {string | null} threadsKey
 * @property {Sheet} threadsSheet
 * @property {HTMLButtonElement} memoryOpen
 * @property {HTMLTextAreaElement} memoryBox
 * @property {HTMLButtonElement} memorySave
 * @property {Sheet} memorySheet
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
 * @property {HTMLInputElement} orchImageInput
 * @property {HTMLButtonElement} orchAttach
 * @property {HTMLDivElement} orchImageStrip
 * @property {Map<string, string | null>} orchImageCache
 * @property {HTMLImageElement} orchImagePreview
 * @property {Sheet} orchImageSheet
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
