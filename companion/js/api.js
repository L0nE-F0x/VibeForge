// @ts-check
// Talking to the computer: a request, the poll that keeps the page current, and an action
// someone tapped, run with the buttons held.

import { forgetSeen, watch } from "./buzz.js";
import { micCancel } from "./mic.js";
import { show, update } from "./pages.js";
import { COMPUTER_KEY, computers, nameComputer, parts, saveComputer, state } from "./state.js";
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
/** The app version the page was loaded from: written into the page, or (by a computer too old for that) its first answer. */
let version = "";
/** The version the page last loaded itself again for, so a page that came back the same doesn't try forever. */
const RELOADED_KEY = "vibeforge-reloaded-for";

/**
 * The computer's answer, read as JSON. A refusal throws with what it said; a link that fails throws `offline`.
 * A read (GET) sends the ETag of its last answer, and a 304 gives that answer back.
 * @param {string} path
 * @param {{ method?: string, body?: BodyInit, timeout?: number, refused?: string, type?: string, acts?: boolean, computer?: { url: string, token: string } }} [options] `refused`: what a refusal that gives no reason means here.
 *   `acts`: it changes something on the computer, so one that got no answer in time may still have been done.
 *   `computer`: another computer than the one on show (one being added, or asked how it is doing). Nothing of its answer is kept.
 * @returns {Promise<any>}
 */
export async function call(path, options = {}) {
  const method = options.method || "GET";
  const own = !options.computer;
  const base = options.computer ? options.computer.url : state.base;
  const token = options.computer ? options.computer.token : state.token;
  /** @type {Record<string, string>} */
  const headers = { ...(options.body ? { "Content-Type": options.type || "application/json" } : {}) };
  if (token) headers.Authorization = `Bearer ${token}`;
  const last = own && method === "GET" ? seen.get(path) : undefined;
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
    response = await fetch(`${base}${path}`, { method, headers, body: options.body, signal: abort?.signal, cache: "no-store" });
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
    // Its code no longer works. Only for the computer still on show: the answer of one switched away from changes nothing.
    if (own && base === state.base) forget();
    throw Object.assign(new Error(body.error || t("phone.pairLead")), { unpaired: true });
  }
  if (!response.ok) throw Object.assign(new Error(body.error || options.refused || t("phone.error.failed")), { working: body.working === true });
  const etag = method === "GET" ? response.headers?.get?.("ETag") : null;
  if (etag && own && base === state.base) seen.set(path, { etag, body });
  return body;
}

/**
 * Asks a computer whether a pairing code is its own: the one on show, or one at another address that
 * is being added. It gives up as a poll does, so a link that doesn't answer says the computer is
 * offline and the button comes back. The answer carries what the computer calls itself.
 * @param {string} code
 * @param {string} [url]
 * A computer from 3.6.3 on also hands this phone a key of its own (`key`), kept instead of the code.
 * @returns {Promise<{ computer?: string, key?: string }>}
 */
export function checkCode(code, url) {
  return call("/api/pair", {
    method: "POST",
    body: JSON.stringify({ token: code }),
    timeout: POLL_TIMEOUT_MS,
    refused: t("phone.codeWrong"),
    ...(url === undefined ? {} : { computer: { url, token: "" } }),
  });
}

/**
 * The key this phone keeps for a computer: its own, when the computer hands one out (3.6.3 on), or
 * the code itself for an older computer.
 * @param {{ key?: string }} answer
 * @param {string} code
 */
export function keyFrom(answer, code) {
  return typeof answer.key === "string" && /^vfd_[0-9a-f]{48}$/.test(answer.key) ? answer.key : code;
}

/**
 * @param {string} path
 * @param {unknown} body
 */
export function post(path, body) {
  return call(path, { method: "POST", body: JSON.stringify(body), timeout: ACTION_TIMEOUT_MS, acts: true });
}

/** The code of the computer on show no longer works: back to pairing with it. It stays in the list. */
export function forget() {
  const shown = computers().find((item) => item.url === state.base);
  if (shown) saveComputer({ ...shown, token: "" });
  state.token = "";
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
 * Shows another of this phone's computers. Nothing of the one before stays on the page: its desk,
 * its session, what was being said to its Orchestrator, and what it was last seen doing (so the
 * other computer's work, already under way, is not buzzed as news).
 * @param {string} url
 */
export function showComputer(url) {
  const next = computers().find((item) => item.url === url);
  if (!next) return;
  micCancel(true);
  localStorage.setItem(COMPUTER_KEY, next.url);
  state.base = next.url;
  state.token = next.token;
  state.desk = null;
  state.session = null;
  state.orch = null;
  state.orchDraft = "";
  state.plans = null;
  state.error = "";
  state.actionError = "";
  seen.clear();
  forgetSeen();
  plansAt = 0;
  pollFailures = 0;
  window.clearTimeout(timer);
  timer = 0;
  state.view = next.token ? "desk" : "pair";
  if (typeof window !== "undefined" && window.history?.replaceState) {
    window.history.replaceState({ view: state.view, sessionQuery: { ...state.sessionQuery } }, "");
  }
  show();
  void loadWords().then((ok) => ok && pageIdle() && show());
  void refresh();
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
    nameComputer(state.base, payload.computer);
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
 * pictures wait to go to the Orchestrator, no action is on its way, and the mic isn't listening or
 * being heard.
 */
export function pageIdle() {
  const focused = typeof document === "undefined" ? null : document.activeElement;
  if (focused && /^(INPUT|TEXTAREA|SELECT)$/.test(focused.tagName)) return false;
  if (state.busy || state.orchDraft.trim() || state.orchImages.length) return false;
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
  // Only the computer this page was loaded from: another of yours may well run another version.
  if (state.base || typeof next !== "string" || !next) return;
  if (!version) version = ownVersion() || next;
  if (next !== version && pageIdle()) reloadOnce(next);
}

function ownVersion() {
  if (typeof document === "undefined") return "";
  return document.querySelector('meta[name="vibeforge-version"]')?.getAttribute("content") || "";
}

/**
 * Loads the page again, once for each version: a page that comes back the same (from the phone's
 * own copy, with the computer too slow to send the new one) would otherwise reload at every poll.
 * @param {string} next
 */
function reloadOnce(next) {
  try {
    if (sessionStorage.getItem(RELOADED_KEY) === next) return;
    sessionStorage.setItem(RELOADED_KEY, next);
  } catch {
    // Nowhere to remember it: load again as before.
  }
  window.location.reload();
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
