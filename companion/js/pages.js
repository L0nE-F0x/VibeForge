// @ts-check
// Which page is on show: building it when the page changes, and bringing it up to date after a
// poll or an action without touching what is being typed.

import { refresh, showComputer } from "./api.js";
import { computersPage, scanCancel, updateComputers } from "./computers.js";
import { deskPage, updateDesk } from "./desk.js";
import { el } from "./dom.js";
import { homePage, pairPage } from "./home.js";
import { maestroPage, updateMaestro } from "./maestro.js";
import { micCancel } from "./mic.js";
import { launchPage, sessionPage, updateLaunch, updateSession } from "./session.js";
import { computers, parts, setParts, state } from "./state.js";
import { t } from "./words.js";

/** @typedef {import("./state.js").Parts} Parts */
/** @typedef {import("./state.js").View} View */

/** The same page the desk and the website credit. */
const APEXFORGE = "https://ame-apexforge.org/";
const app = /** @type {HTMLElement} */ (document.querySelector("#app"));

/** Builds the page for the current view from scratch. Only a change of view does this. */
export function show() {
  state.ticket += 1;
  // The mic belongs to the Orchestrator's box: leaving the page puts it down.
  if (state.view !== "maestro") micCancel();
  // And the camera to the list of computers.
  if (state.view !== "computers") scanCancel();
  // The install offer only shows on the code and the landing page (app.css), never over a text box.
  document.body.dataset.view = state.token || state.view === "computers" ? state.view : "pair";
  setParts(/** @type {Parts} */ ({}));
  parts.banner = banner();
  app.replaceChildren(parts.banner, page(), credit());
  update();
}

/** Brings the page on show up to date without touching what is being typed. */
export function update() {
  // What an action ran into comes first: it is what the person just did.
  const said = state.actionError || state.error;
  parts.banner.hidden = !said;
  if (parts.bannerText.textContent !== said) parts.bannerText.textContent = said;
  parts.bannerClose.hidden = !state.actionError;
  if (state.view === "computers") {
    updateComputers();
    return;
  }
  if (!state.token || state.view === "pair") {
    if (parts.pair) parts.pair.disabled = state.busy;
    return;
  }
  if (state.view === "desk") updateDesk();
  else if (state.view === "launch") updateLaunch();
  else if (state.view === "session") updateSession();
  else if (state.view === "maestro") updateMaestro();
}

/**
 * What went wrong, read out as it appears. An action's error has a close button; the poll's own goes
 * away by itself once the computer answers again.
 */
function banner() {
  parts.bannerText = el("span", { class: "banner-text" });
  parts.bannerClose = el(
    "button",
    {
      class: "banner-close",
      type: "button",
      hidden: true,
      "aria-label": t("common.close"),
      title: t("common.close"),
      onclick: () => {
        state.actionError = "";
        update();
      },
    },
    "×",
  );
  return el("div", { class: "banner", role: "alert", "aria-live": "assertive", hidden: true }, parts.bannerText, parts.bannerClose);
}

/** @param {View} next */
export function setView(next) {
  // Without a code for the computer on show there is only the page that asks for it, and the list of computers.
  const resolved = state.token || next === "computers" ? next : "pair";
  if (resolved !== state.view && typeof window !== "undefined" && window.history?.pushState) {
    window.history.pushState({ view: resolved, sessionQuery: { ...state.sessionQuery } }, "");
  }
  state.view = resolved;
  show();
  if (state.token) void refresh();
}

/** Keeps Back navigation inside Companion views rather than closing the PWA immediately. */
export function listenHistory() {
  if (typeof window === "undefined" || !window.history?.replaceState) return;
  window.history.replaceState({ view: state.view, sessionQuery: { ...state.sessionQuery } }, "");
  window.addEventListener("popstate", (event) => {
    const entry = event.state && typeof event.state === "object" ? event.state : null;
    if (entry?.sessionQuery && typeof entry.sessionQuery === "object") {
      state.sessionQuery = {
        ptyId: typeof entry.sessionQuery.ptyId === "string" ? entry.sessionQuery.ptyId : "",
        runId: typeof entry.sessionQuery.runId === "string" ? entry.sessionQuery.runId : "",
      };
    }
    const candidate = /** @type {View | undefined} */ (entry?.view);
    const next = candidate && (state.token || candidate === "computers") ? candidate : state.token ? "desk" : "pair";
    if (next === state.view) return;
    state.view = next;
    show();
    if (state.token) void refresh();
  });
}

/** The pages a link may name with `?view=`. */
const LINK_VIEWS = /** @type {Record<string, View>} */ ({ desk: "desk", maestro: "maestro", viby: "maestro", home: "home", computers: "computers" });

/**
 * A link that opens the page at one place on the computer it came from: a session
 * (`?ptyId=…&runId=…`), one of the Orchestrator's plans (`?turn=…`), or a page (`?view=desk`,
 * `?view=maestro`). The Android widget opens these when something on it is tapped. Until the phone
 * is paired with that computer the link stays in the address, and pairing follows it.
 * Returns true when the link chose the page.
 */
export function followLink() {
  if (typeof window === "undefined") return false;
  const url = new URL(window.location.href);
  const ptyId = (url.searchParams.get("ptyId") || "").slice(0, 80);
  const runId = (url.searchParams.get("runId") || "").slice(0, 200);
  const turn = (url.searchParams.get("turn") || "").slice(0, 80);
  const view = LINK_VIEWS[url.searchParams.get("view") || ""];
  if (!ptyId && !runId && !turn && !view) return false;
  // The link is about the computer this page came from, not another one this phone shows.
  const home = computers()[0];
  if (!home.token) return false;
  window.history.replaceState(null, "", url.pathname);
  if (state.base) showComputer("");
  if (ptyId || runId) {
    state.sessionQuery = { ptyId, runId };
    state.session = null;
    state.view = "session";
  } else if (turn) {
    state.focusTurn = turn;
    state.view = "maestro";
  } else state.view = view;
  return true;
}

function page() {
  if (state.view === "computers") return computersPage();
  if (state.view === "pair" || !state.token) return pairPage();
  if (state.view === "home") return homePage();
  if (state.view === "launch") return launchPage();
  if (state.view === "session") return sessionPage();
  if (state.view === "maestro") return maestroPage();
  return deskPage();
}

/** "Created by ApexForge", the same credit as the desk and the website. */
function credit() {
  const [before, after = ""] = t("phone.credit").split("{name}");
  return el(
    "p",
    { class: "credit" },
    before,
    el("a", { href: APEXFORGE, target: "_blank", rel: "noopener noreferrer" }, "ApexForge"),
    after,
  );
}
