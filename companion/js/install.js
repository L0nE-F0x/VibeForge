// @ts-check
// The offer to install the page as an app, on a phone that hasn't yet.

import { el } from "./dom.js";
import { INSTALL_KEY } from "./state.js";
import { t } from "./words.js";

/**
 * Chrome's install prompt, held until Install is tapped (not in TypeScript's DOM types).
 * @typedef {Event & { prompt: () => Promise<void>, userChoice: Promise<{ outcome: string }> }} InstallEvent
 */

/** @type {InstallEvent | null} */
let installEvent = null;

function installedApp() {
  return window.matchMedia("(display-mode: fullscreen)").matches || window.matchMedia("(display-mode: standalone)").matches || /** @type {{ standalone?: boolean }} */ (navigator).standalone === true;
}

export function offerInstall() {
  const card = document.querySelector(".install");
  const touch = window.matchMedia("(pointer: coarse)").matches || navigator.maxTouchPoints > 0;
  const narrow = window.matchMedia("(max-width: 640px)").matches;
  const phone = touch || narrow || /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
  if (installedApp() || localStorage.getItem(INSTALL_KEY) === "1" || !phone) {
    card?.remove();
    return;
  }
  if (card) return;
  const ios = /iPhone|iPad|iPod/i.test(navigator.userAgent);
  const copy = el("p", {}, ios ? t("phone.installIos") : t("phone.installBody"));
  const install = ios
    ? null
    : el("button", { class: "btn", type: "button", onclick: () => void acceptInstall(copy) }, t("phone.install"));
  const later = el("button", { class: "ghost", type: "button", onclick: dismissInstall }, t("phone.installLater"));
  document.body.append(
    el(
      "div",
      { class: "install", role: "dialog", "aria-label": t("phone.installTitle") },
      el("div", { class: "install-title" }, t("phone.installTitle")),
      copy,
      el("div", { class: "actions" }, install, later),
    ),
  );
}

/** @param {HTMLElement} copy */
async function acceptInstall(copy) {
  if (!installEvent) {
    copy.textContent = t("phone.installMenu");
    return;
  }
  const event = installEvent;
  installEvent = null;
  await event.prompt();
  const choice = await event.userChoice;
  if (choice?.outcome === "accepted") document.querySelector(".install")?.remove();
}

function dismissInstall() {
  localStorage.setItem(INSTALL_KEY, "1");
  document.querySelector(".install")?.remove();
}

/** Chrome says when the page can be installed, and when it was. */
export function listenForInstall() {
  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    installEvent = /** @type {InstallEvent} */ (event);
    offerInstall();
  });

  window.addEventListener("appinstalled", () => {
    installEvent = null;
    localStorage.setItem(INSTALL_KEY, "1");
    document.querySelector(".install")?.remove();
  });
}
