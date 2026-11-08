// @ts-check
// Before the desk: pairing with the code from the computer, and the landing page a paired phone
// opens on, with how it works and the phone's own settings.

import { wordmark } from "./art.js";
import { forgetSeen } from "./buzz.js";
import { el, sheet } from "./dom.js";
import { setView, update } from "./pages.js";
import { BUZZ_KEY, buzzShownOn, PLANS_KEY, parts, plansOpen, state, TEXT_KEY, TOKEN_KEY, TUCK_KEY, textLarge, tuckFinished } from "./state.js";
import { t } from "./words.js";

export function pairPage() {
  const input = el("input", {
    id: "code",
    autocapitalize: "off",
    autocorrect: "off",
    spellcheck: "false",
    placeholder: "vf_…",
    onkeydown: (event) => {
      if (event.key === "Enter") void pair(input.value);
    },
  });
  parts.pair = el("button", { class: "btn", type: "button", onclick: () => void pair(input.value) }, t("phone.continue"));
  return el(
    "section",
    {},
    el("div", { class: "brand" }, wordmark(), el("h1", {}, "VibeForge")),
    el("p", { class: "muted lede" }, t("phone.pairLead")),
    el("div", { class: "card stack" }, el("label", {}, t("phone.code"), input), parts.pair),
  );
}

/** @param {string} code */
async function pair(code) {
  const given = code.trim();
  state.busy = true;
  state.error = "";
  update();
  try {
    const response = await fetch("/api/pair", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: given }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || t("phone.codeWrong"));
    state.token = given;
    localStorage.setItem(TOKEN_KEY, state.token);
    state.busy = false;
    forgetSeen();
    setView("home");
  } catch (err) {
    state.error = err.message;
    state.busy = false;
    update();
  }
}

/**
 * @param {HTMLElement} button
 * @param {boolean} on
 */
function paintSwitch(button, on) {
  button.classList.toggle("on", on);
  button.setAttribute("aria-checked", on ? "true" : "false");
}

/**
 * @param {string} label
 * @param {string} hint
 * @param {boolean} on
 * @param {(next: boolean, button: HTMLButtonElement) => unknown} change
 */
function prefSwitch(label, hint, on, change) {
  const button = el(
    "button",
    {
      class: on ? "switch on" : "switch",
      type: "button",
      role: "switch",
      "aria-checked": on ? "true" : "false",
    },
    el("span", { class: "copy" }, el("span", { class: "label" }, label), hint ? el("span", { class: "hint" }, hint) : null),
    el("span", { class: "knob", "aria-hidden": "true" }),
  );
  button.addEventListener("click", () => {
    const next = button.getAttribute("aria-checked") !== "true";
    void change(next, button);
  });
  return button;
}

let askingBuzz = false;

/**
 * @param {boolean} want
 * @param {HTMLButtonElement} button
 */
async function onBuzz(want, button) {
  if (askingBuzz) return;
  if (!want) {
    localStorage.setItem(BUZZ_KEY, "0");
    paintSwitch(button, false);
    return;
  }
  if (typeof Notification === "undefined") return;
  askingBuzz = true;
  try {
    let permission = Notification.permission;
    if (permission === "default") permission = await Notification.requestPermission();
    const granted = permission === "granted";
    localStorage.setItem(BUZZ_KEY, granted ? "1" : "0");
    paintSwitch(button, granted);
    if (parts.buzzNote) parts.buzzNote.hidden = permission !== "denied";
  } finally {
    askingBuzz = false;
  }
}

export function homePage() {
  const blocked = typeof Notification !== "undefined" && Notification.permission === "denied";
  parts.buzzNote = el("p", { class: "small faint home-note", hidden: !blocked }, t("phone.homeBuzzBlocked"));
  const how = sheet(
    t("phone.homeHowTitle"),
    el("p", { class: "muted lede" }, t("phone.homeLead")),
    el("p", { class: "how" }, t("phone.homeHow")),
    el("p", { class: "how" }, t("phone.homeHowMaestro")),
    el("p", { class: "small muted reach" }, t("phone.homeReach")),
    el("p", { class: "small faint home-return" }, t("phone.homeReturn")),
  );
  const settings = sheet(
    t("phone.homeSettings"),
    el(
      "article",
      { class: "card home-settings" },
      prefSwitch(t("phone.homeBuzz"), t("phone.homeBuzzHint"), buzzShownOn(), onBuzz),
      parts.buzzNote,
      prefSwitch(t("phone.homePlans"), t("phone.homePlansHint"), plansOpen(), (on, button) => {
        localStorage.setItem(PLANS_KEY, on ? "1" : "0");
        paintSwitch(button, on);
      }),
      prefSwitch(t("phone.homeTuck"), t("phone.homeTuckHint"), tuckFinished(), (on, button) => {
        localStorage.setItem(TUCK_KEY, on ? "1" : "0");
        paintSwitch(button, on);
      }),
      prefSwitch(t("phone.homeText"), "", textLarge(), (on, button) => {
        localStorage.setItem(TEXT_KEY, on ? "1" : "0");
        document.documentElement.classList.toggle("large", on);
        paintSwitch(button, on);
      }),
    ),
  );
  return el(
    "section",
    { class: "home" },
    el(
      "div",
      { class: "home-hero" },
      el("div", { class: "brand" }, wordmark(), el("h1", {}, "VibeForge")),
      el("p", { class: "home-kind" }, t("phone.homeKind")),
      el("p", { class: "muted home-blurb" }, t("phone.homeBlurb")),
      el(
        "div",
        { class: "home-actions" },
        el("button", { class: "ghost home-action", type: "button", onclick: () => how.open() }, t("phone.homeHowTitle")),
        el("button", { class: "ghost home-action", type: "button", onclick: () => settings.open() }, t("phone.homeSettings")),
        el("button", { class: "btn home-enter", type: "button", onclick: () => setView("desk") }, t("phone.homeEnter")),
      ),
    ),
    how,
    settings,
  );
}
