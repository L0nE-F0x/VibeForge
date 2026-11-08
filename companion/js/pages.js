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
  setParts(/** @type {Parts} */ ({ banner: el("div", { class: "banner", hidden: true }) }));
  app.replaceChildren(parts.banner, page(), credit());
  update();
}

/** Brings the page on show up to date without touching what is being typed. */
export function update() {
  parts.banner.hidden = !state.error;
  parts.banner.textContent = state.error;
  if (state.view === "desk") updateDesk();
  else if (state.view === "launch") updateLaunch();
  else if (state.view === "session") updateSession();
  else if (state.view === "maestro") updateMaestro();
  else if (state.view === "pair" && parts.pair) parts.pair.disabled = state.busy;
}

/** @param {View} next */
export function setView(next) {
  state.view = next;
  show();
  void refresh();
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
