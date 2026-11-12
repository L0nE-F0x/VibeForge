// @ts-check
// Talking to the computer: a request, the poll that keeps the page current, and an action
// someone tapped, run with the buttons held.

import { watch } from "./buzz.js";
import { show, update } from "./pages.js";
import { parts, state, TOKEN_KEY } from "./state.js";
import { loadWords, t, wordsLoaded } from "./words.js";

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
 * What a person tapped waits this long for its answer. Longer than any start takes (a copy of a big
 * repository, a CLI that is slow to come up); past it the link is gone, and the buttons come back.
 */
const ACTION_TIMEOUT_MS = 60_000;
/** What a proxy in front of the computer answers when nothing is listening behind it (Tailscale Serve, with VibeForge closed). */
const GATEWAY_DOWN = [502, 503, 504];
/** The last answer to each read, by its ETag: the computer answers 304 when nothing changed, and this stands in. @type {Map<string, { etag: string, body: any }>} */
const seen = new Map();
/** The app version the page was loaded from, once the computer has said it. */
let version = "";

/**
 * The computer's answer, read as JSON. A refusal throws with what it said; a link that fails throws `offline`.
 * A read (GET) sends the ETag of its last answer, and a 304 gives that answer back.
 * @param {string} path
 * @param {{ method?: string, body?: BodyInit, timeout?: number, refused?: string, type?: string, acts?: boolean }} [options] `refused`: what a refusal that gives no reason means here.
 *   `acts`: it changes something on the computer, so one that got no answer in time may still have been done.
 * @returns {Promise<any>}
 */
export async function call(path, options = {}) {
  const method = options.method || "GET";
  /** @type {Record<string, string>} */
  const headers = { ...(options.body ? { "Content-Type": options.type || "application/json" } : {}) };
  if (state.token) headers.Authorization = `Bearer ${state.token}`;
  const last = method === "GET" ? seen.get(path) : undefined;
  if (last) headers["If-None-Match"] = last.etag;
  const abort = options.timeout ? new AbortController() : null;
  const limit = abort ? window.setTimeout(() => abort.abort(), options.timeout) : 0;
  /** @type {Response} */
  let response;
  /** @type {any} */
  let body;
  // An answer that isn't the computer's JSON came from something in between, not from VibeForge.
  let ours = true;
  try {
    response = await fetch(path, { method, headers, body: options.body, signal: abort?.signal, cache: "no-store" });
    if (response.status === 304 && last) return last.body;
    body = await response.json().catch(() => {
      if (abort?.signal.aborted) throw new Error("timed out");
      ours = false;
      return {};
    });
  } catch {
    // An action that got no answer may still have been done; a read (or a code checked) that got none wasn't.
    throw Object.assign(new Error(options.acts && abort?.signal.aborted ? t("phone.timedOut") : t("phone.offline")), { offline: true });
  } finally {
    window.clearTimeout(limit);
  }
  if (!response.ok && (!ours || GATEWAY_DOWN.includes(response.status))) throw Object.assign(new Error(t("phone.offline")), { offline: true });
  if (response.status === 401 && path !== "/api/pair") {
    forget();
    throw new Error(body.error || t("phone.pairLead"));
  }
  if (!response.ok) throw Object.assign(new Error(body.error || options.refused || t("phone.error.failed")), { working: body.working === true });
  const etag = method === "GET" ? response.headers?.get?.("ETag") : null;
  if (etag) seen.set(path, { etag, body });
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
  return call(path, { method: "POST", body: JSON.stringify(body), timeout: ACTION_TIMEOUT_MS, acts: true });
}

/** The code no longer works here: back to pairing. */
export function forget() {
  state.token = "";
  localStorage.removeItem(TOKEN_KEY);
  state.desk = null;
  state.session = null;
  seen.clear();
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
    checkVersion(payload.version);
    // Plan limits move slowly, and reading them may ask the providers: once a minute is plenty, and
    // the page doesn't wait for them (a provider that is slow to answer would hold every update).
    if (Date.now() - plansAt > PLANS_EVERY_MS) {
      plansAt = Date.now();
      void loadPlans();
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
    // The poll's own trouble only: what an action said stays on the banner (state.actionError).
    state.error = refused;
    pollFailures = 0;
    // The words didn't come when the page opened: now that the computer answers, ask again.
    if (!wordsLoaded()) void loadWords().then((ok) => ok && pageIdle() && show());
  } catch (err) {
    if (mine !== state.ticket) return;
    state.error = err.message;
    // Waiting longer is for a computer that doesn't answer; one that answered with a refusal is asked again as usual.
    pollFailures = err.offline ? pollFailures + 1 : 0;
  }
  if (state.view !== shown) show();
  else update();
}

/** Plan limits, read on their own: the desk shows them when they arrive. */
async function loadPlans() {
  try {
    const answer = await call("/api/plans", { timeout: POLL_TIMEOUT_MS });
    state.plans = answer.plans ?? null;
    if (state.view === "desk") update();
  } catch {
    // The ones it had stay; the next minute asks again.
  }
}

/**
 * Nothing on the page would be lost by building it again: no box has focus or words in it, no
 * action is on its way, and the mic isn't listening or being heard.
 */
export function pageIdle() {
  const focused = typeof document === "undefined" ? null : document.activeElement;
  if (focused && /^(INPUT|TEXTAREA|SELECT)$/.test(focused.tagName)) return false;
  if (state.busy || state.orchDraft.trim()) return false;
  for (const box of [parts.prompt, parts.box]) if (box?.isConnected && box.value.trim()) return false;
  const phase = parts.mic?.dataset.phase;
  return !phase || phase === "idle";
}

/**
 * The computer runs another version than the one this page came from (it was updated and
 * restarted): the page loads again, once nothing on it would be lost, so it matches the computer.
 * @param {unknown} next
 */
function checkVersion(next) {
  if (typeof next !== "string" || !next) return;
  if (!version) version = next;
  else if (next !== version && pageIdle()) window.location.reload();
}

function schedule(delay = POLL_MS) {
  window.clearTimeout(timer);
  timer = 0;
  if (!state.token) return;
  timer = window.setTimeout(() => void refresh(), delay);
}

/**
 * Runs one action with the buttons held. Returns what the action returned, or false when it failed.
 * What went wrong stays on the banner until the next action, or until it is tapped away: the poll
 * that follows doesn't clear it.
 * @template T
 * @param {() => Promise<T> | T} task
 * @returns {Promise<T | false>}
 */
export async function withBusy(task) {
  const shown = state.view;
  state.busy = true;
  state.actionError = "";
  update();
  /** @type {T | false} */
  let result = false;
  try {
    result = await task();
  } catch (err) {
    state.actionError = err.message;
  }
  state.busy = false;
  if (state.view !== shown) show();
  else update();
  void refresh();
  return result;
}
