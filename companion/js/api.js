// @ts-check
// Talking to the computer: a request, the poll that keeps the page current, and an action
// someone tapped, run with the buttons held.

import { watch } from "./buzz.js";
import { show, update } from "./pages.js";
import { state, TOKEN_KEY } from "./state.js";
import { t } from "./words.js";

/** The poll: one at a time, the next two seconds after the last one ends, slower while the computer doesn't answer. */
const POLL_MS = 2000;
const POLL_SLOWEST_MS = 16_000;
/** A poll that takes longer gives up, so a stalled link shows as offline instead of a page that stops. */
const POLL_TIMEOUT_MS = 15_000;
let polling = false;
let pollAgain = false;
let pollFailures = 0;
let timer = 0;
let plansAt = 0;
const PLANS_EVERY_MS = 60_000;

/**
 * The computer's answer, read as JSON. A refusal throws with what it said; a link that fails throws `offline`.
 * @param {string} path
 * @param {{ method?: string, body?: string, timeout?: number, refused?: string }} [options] `refused`: what a refusal that gives no reason means here.
 * @returns {Promise<any>}
 */
export async function call(path, options = {}) {
  /** @type {Record<string, string>} */
  const headers = { ...(options.body ? { "Content-Type": "application/json" } : {}) };
  if (state.token) headers.Authorization = `Bearer ${state.token}`;
  // A poll gives up after `timeout`; what a person tapped waits for its answer.
  const abort = options.timeout ? new AbortController() : null;
  const limit = abort ? window.setTimeout(() => abort.abort(), options.timeout) : 0;
  /** @type {Response} */
  let response;
  /** @type {any} */
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
  if (!response.ok) throw Object.assign(new Error(body.error || options.refused || t("phone.error.failed")), { working: body.working === true });
  return body;
}

/**
 * Asks the computer whether a pairing code is its own. It gives up as a poll does, so a link that
 * doesn't answer says the computer is offline and Continue comes back.
 * @param {string} code
 */
export function checkCode(code) {
  return call("/api/pair", { method: "POST", body: JSON.stringify({ token: code }), timeout: POLL_TIMEOUT_MS, refused: t("phone.codeWrong") });
}

/**
 * @param {string} path
 * @param {unknown} body
 */
export function post(path, body) {
  return call(path, { method: "POST", body: JSON.stringify(body) });
}

/** The code no longer works here: back to pairing. */
export function forget() {
  state.token = "";
  localStorage.removeItem(TOKEN_KEY);
  state.desk = null;
  state.session = null;
  window.clearTimeout(timer);
  timer = 0;
  if (state.view !== "pair") {
    state.view = "pair";
    show();
  }
}

/**
 * Polls now, and the next poll follows when this one is done. One already on its way is not overtaken:
 * on a slow link, polls every two seconds regardless dropped each other and the page stopped changing.
 */
export async function refresh() {
  if (!state.token || state.view === "pair") return;
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
  const mine = ++state.ticket;
  const shown = state.view;
  const timeout = POLL_TIMEOUT_MS;
  try {
    const payload = await call("/api/desk", { timeout });
    // A change of page has already replaced what this one would show: the next poll asks for that page.
    if (mine !== state.ticket) return;
    // Plan limits move slowly, and reading them may ask the providers: once a minute is plenty.
    if (Date.now() - plansAt > PLANS_EVERY_MS) {
      plansAt = Date.now();
      state.plans = (await call("/api/plans", { timeout }).catch(() => ({ plans: state.plans }))).plans ?? null;
    }
    // The page on show reads more than the desk. A refusal there (a session that has gone) goes on the
    // banner and the desk still updates: only a computer that can't be reached fails the whole poll.
    let refused = "";
    /** @param {string} route */
    const more = (route) =>
      call(route, { timeout }).catch((err) => {
        if (err.offline) throw err;
        refused = err.message;
        return undefined;
      });
    const next = state.view === "session" ? await more(`/api/session?ptyId=${encodeURIComponent(state.sessionQuery.ptyId)}&runId=${encodeURIComponent(state.sessionQuery.runId)}`) : null;
    const nextOrch = state.view === "maestro" ? await more("/api/orchestrator") : null;
    if (mine !== state.ticket) return;
    watch(payload);
    state.desk = payload;
    // A refused read leaves what the page last showed.
    if (state.view === "session" && next !== undefined) state.session = next;
    if (state.view === "maestro" && nextOrch !== undefined) state.orch = nextOrch;
    state.error = refused;
    pollFailures = 0;
  } catch (err) {
    if (mine !== state.ticket) return;
    state.error = err.message;
    // Waiting longer is for a computer that doesn't answer; one that answered with a refusal is asked again as usual.
    pollFailures = err.offline ? pollFailures + 1 : 0;
  }
  if (state.view !== shown) show();
  else update();
}

function schedule(delay = POLL_MS) {
  window.clearTimeout(timer);
  timer = 0;
  if (!state.token) return;
  timer = window.setTimeout(() => void refresh(), delay);
}

/**
 * Runs one action with the buttons held. Returns what the action returned, or false when it failed.
 * @template T
 * @param {() => Promise<T> | T} task
 * @returns {Promise<T | false>}
 */
export async function withBusy(task) {
  const shown = state.view;
  state.busy = true;
  state.error = "";
  update();
  /** @type {T | false} */
  let result = false;
  try {
    result = await task();
  } catch (err) {
    state.error = err.message;
  }
  state.busy = false;
  if (state.view !== shown) show();
  else update();
  void refresh();
  return result;
}
