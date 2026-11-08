// @ts-check
// The phone page (README.md, "Phone"). This file starts it; its parts are the ES modules in js/,
// served as they are (no bundler) and each one named in the server's list of files
// (src/core/companion-http.ts) and preloaded by index.html.
//
//   js/state.js      what the modules share, and what the phone keeps
//   js/words.js      the page's words in the phone's language
//   js/dom.js        elements, bars and panels        js/art.js     the pixel art
//   js/api.js        requests, the poll, actions      js/buzz.js    buzzing the phone
//   js/pages.js      which page is on show            js/home.js    pairing and the landing page
//   js/desk.js       the desk and plan limits         js/session.js starting someone, and one session
//   js/maestro.js    the Orchestrator                 js/plan-card.js  a plan's card
//   js/mic.js        talking to it                    js/install.js the install offer

import { refresh } from "./js/api.js";
import { listenForInstall, offerInstall } from "./js/install.js";
import { show } from "./js/pages.js";
import { openSession } from "./js/session.js";
import { state, TEXT_KEY } from "./js/state.js";
import { loadWords } from "./js/words.js";

if (localStorage.getItem(TEXT_KEY) === "1") document.documentElement.classList.add("large");

listenForInstall();

/**
 * Keep the page inside the visible screen while the phone keyboard is open.
 * The layout viewport stays full height on iOS; the visual viewport is the part
 * the keyboard has not covered. Chrome also honours interactive-widget on the
 * viewport tag, and then this inset is zero.
 */
function followKeyboard() {
  const vv = window.visualViewport;
  const height = vv && vv.height > 0 ? vv.height : window.innerHeight;
  const top = vv ? vv.offsetTop : 0;
  if (!(height > 0)) return;
  const keyboard = Math.max(0, window.innerHeight - top - height);
  const root = document.documentElement;
  root.style.setProperty("--vv-top", `${top}px`);
  root.style.setProperty("--vv-height", `${height}px`);
  root.style.setProperty("--keyboard", `${keyboard}px`);
  const opened = keyboard > 60;
  root.classList.toggle("keyboard", opened);
  if (opened !== keyboardWasOpen) {
    keyboardWasOpen = opened;
    const focused = document.activeElement;
    if (focused instanceof HTMLTextAreaElement || focused instanceof HTMLInputElement || focused instanceof HTMLSelectElement) {
      focused.scrollIntoView({ block: "nearest" });
    }
  }
}

let keyboardWasOpen = false;

if (window.visualViewport) {
  let frame = 0;
  const trackKeyboard = () => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(followKeyboard);
  };
  window.visualViewport.addEventListener("resize", trackKeyboard);
  window.visualViewport.addEventListener("scroll", trackKeyboard);
}
followKeyboard();

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.addEventListener("message", (event) => {
    if (event.data?.type !== "open") return;
    openSession({ ptyId: event.data.ptyId || "", runId: event.data.runId || "" });
  });
  void navigator.serviceWorker.register("/sw.js");
}

// Back on the page after the phone was locked: what changed shows now, not at the next poll.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") void refresh();
});

void loadWords().then(() => {
  show();
  offerInstall();
  if (state.token) void refresh();
});
