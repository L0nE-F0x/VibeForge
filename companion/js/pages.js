// @ts-check
// Which page is on show: building it when the page changes, and bringing it up to date after a
// poll or an action without touching what is being typed.

import { refresh } from "./api.js";
import { deskPage, updateDesk } from "./desk.js";
import { el } from "./dom.js";
import { homePage, pairPage } from "./home.js";
import { maestroPage, updateMaestro } from "./maestro.js";
import { micCancel } from "./mic.js";
import { launchPage, sessionPage, updateLaunch, updateSession } from "./session.js";
import { parts, setParts, state } from "./state.js";
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
  // The install offer only shows on the code and the landing page (app.css), never over a text box.
  document.body.dataset.view = state.token ? state.view : "pair";
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
  state.view = state.token ? next : "pair";
  show();
  if (state.token) void refresh();
}

function page() {
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
