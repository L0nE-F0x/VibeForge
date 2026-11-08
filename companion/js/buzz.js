// @ts-check
// The phone buzzes when someone on the computer starts waiting, or finishes.

import { buzzWanted } from "./state.js";
import { t } from "./words.js";

/** @typedef {import("./state.js").DeskPayload} DeskPayload */
/** @typedef {import("./state.js").DeskSession} DeskSession */

/** @type {Map<string, DeskSession>} */
let known = new Map();
let primed = false;

/**
 * @param {string} body
 * @param {{ key: string, ptyId: string, runId: string }} data
 */
async function buzz(body, data) {
  if (!buzzWanted()) return;
  if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
  const note = { body, tag: data.key, renotify: true, data };
  try {
    const ready = navigator.serviceWorker && (await navigator.serviceWorker.ready);
    if (ready) await ready.showNotification("VibeForge", note);
    else new Notification("VibeForge", note);
  } catch {
    /* a missed buzz is not a failed send */
  }
}

/** @param {DeskPayload} payload */
export function watch(payload) {
  const next = new Map();
  for (const workspace of payload.workspaces) {
    for (const item of workspace.sessions) {
      const key = item.runId || item.ptyId;
      if (!key) continue;
      next.set(key, item);
      const previous = known.get(key);
      if (!primed || !previous || previous.state === item.state) continue;
      if (item.state === "waiting" && previous.state === "working") void buzz(t("phone.buzzWaiting", { name: item.title }), { key, ptyId: item.ptyId || "", runId: item.runId || "" });
      if (item.state === "done") void buzz(`${t("phone.buzzFinished", { name: item.title })}${item.changes ? ` · ${item.changes}` : ""}`, { key, ptyId: "", runId: item.runId || "" });
    }
  }
  if (primed) {
    for (const [key, previous] of known) {
      if (next.has(key) || previous.state === "done") continue;
      void buzz(t("phone.buzzFinished", { name: previous.title }), { key, ptyId: "", runId: previous.runId || "" });
    }
  }
  known = next;
  primed = true;
}

/** A new pairing starts over: what is running already is not news. */
export function forgetSeen() {
  primed = false;
  known = new Map();
}
