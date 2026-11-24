// @ts-check
// The computers this phone shows: which one is on show, the others and how they are doing,
// adding one by its address and pairing code, and taking one off.

import { readAddress } from "./address.js";
import { call, checkCode, keyFrom, showComputer, withBusy } from "./api.js";
import { codeField, el } from "./dom.js";
import { setView, update } from "./pages.js";
import { computerLabel, computers, nameComputer, parts, removeComputer, saveComputer, state } from "./state.js";
import { t } from "./words.js";

/** @typedef {import("./state.js").Computer} Computer */
/** @typedef {import("./state.js").View} View */

/** How long a computer has to say how it is doing before the list calls it unreachable. */
const ASK_TIMEOUT_MS = 8000;

/** Where Back goes: the page the list was opened from. @type {View} */
let cameFrom = "home";

/** How each computer answered when the list last asked, by address. @type {Map<string, { text: string, dot: string }>} */
let answers = new Map();

/** Turns the camera off again, while it is reading a QR code. @type {(() => void) | null} */
let stopScan = null;

/** More than the one this page came from: only then is there anything to switch to. */
export function severalComputers() {
  return computers().length > 1;
}

/** The computer on show, as a button that opens the list of them. */
export function computerChip() {
  const shown = computers().find((item) => item.url === state.base) ?? computers()[0];
  return el(
    "button",
    { class: "ghost computer-chip", type: "button", onclick: openComputers },
    el("span", { class: state.token ? "px working" : "px done", "aria-hidden": "true" }),
    el("span", { class: "grow title" }, computerLabel(shown)),
    el("span", { class: "small faint" }, t("phone.computers")),
  );
}

function openComputers() {
  cameFrom = state.view === "desk" ? "desk" : "home";
  setView("computers");
}

export function computersPage() {
  scanCancel();
  answers = new Map();
  parts.computerList = el("div", { class: "card computers" });
  paintComputers();
  void askComputers();
  // Without a code for the computer on show, Back is the page that asks for it (setView sees to that).
  const back = el("button", { class: "back", type: "button", onclick: () => setView(cameFrom) }, t("phone.back"));
  return el("section", {}, el("div", { class: "top" }, back, el("h1", {}, t("phone.computers"))), parts.computerList, addCard());
}

export function updateComputers() {
  if (parts.addComputer) parts.addComputer.disabled = state.busy;
}

function paintComputers() {
  if (!parts.computerList) return;
  parts.computerList.replaceChildren(...computers().map((computer) => computerRow(computer)));
}

/** @param {Computer} computer */
function computerRow(computer) {
  const shown = computer.url === state.base;
  const answer = answers.get(computer.url) ?? { text: computer.token ? t("phone.computerChecking") : t("phone.computerNeedsCode"), dot: "done" };
  return el(
    "div",
    { class: "computer" },
    el(
      "button",
      { class: "computer-pick", type: "button", "aria-current": shown ? "true" : null, onclick: () => showComputer(computer.url) },
      el("div", { class: "row" }, el("span", { class: `px ${answer.dot}`, "aria-hidden": "true" }), el("div", { class: "grow title" }, computerLabel(computer)), shown ? el("span", { class: "pill working" }, t("phone.computerShown")) : null),
      el("div", { class: "small muted" }, answer.text),
    ),
    // The computer this page came from stays: the page is its own.
    computer.url
      ? el(
          "button",
          {
            class: "ghost danger small-btn",
            type: "button",
            onclick: () => {
              if (!window.confirm(t("phone.computerRemoveConfirm", { name: computerLabel(computer) }))) return;
              removeComputer(computer.url);
              if (shown) showComputer("");
              else paintComputers();
            },
          },
          t("phone.computerRemove"),
        )
      : null,
  );
}

/** Asks every paired computer once how it is doing, so the list says who is busy before you switch. */
async function askComputers() {
  const list = parts.computerList;
  await Promise.all(
    computers()
      .filter((computer) => computer.token)
      .map(async (computer) => {
        /** @type {{ text: string, dot: string }} */
        let answer;
        try {
          const desk = await call("/api/desk", { computer, timeout: ASK_TIMEOUT_MS });
          nameComputer(computer.url, desk.computer);
          answer = howBusy(desk);
        } catch (err) {
          answer = { text: err.unpaired ? t("phone.computerNeedsCode") : t("phone.computerOffline"), dot: "done" };
        }
        // The page has moved on: nothing to paint.
        if (parts.computerList !== list || !list?.isConnected) return;
        answers.set(computer.url, answer);
        paintComputers();
      }),
  );
}

/** @param {import("./state.js").DeskPayload} desk */
function howBusy(desk) {
  let working = 0;
  let waiting = 0;
  for (const workspace of desk.workspaces ?? []) {
    for (const item of workspace.sessions ?? []) {
      if (item.state === "working") working += 1;
      else if (item.state === "waiting") waiting += 1;
    }
  }
  const said = [working ? t("phone.computerWorking", { count: working }) : "", waiting ? t("phone.computerWaiting", { count: waiting }) : ""].filter(Boolean);
  return { text: said.join(" · ") || t("phone.nothingRunning"), dot: waiting ? "waiting" : working ? "working" : "done" };
}

function addCard() {
  const address = el("input", {
    id: "computer-address",
    type: "text",
    inputmode: "url",
    autocomplete: "off",
    autocapitalize: "off",
    autocorrect: "off",
    spellcheck: "false",
    placeholder: t("phone.computerAddressHint"),
    onkeydown: (event) => {
      if (event.key === "Enter") code.input.focus();
    },
  });
  const code = codeField("computer-code", () => void add(address.value, code.input.value));
  parts.addComputer = el("button", { class: "btn", type: "button", onclick: () => void add(address.value, code.input.value) }, t("phone.computerAdd"));
  const view = el("div", { class: "scan", hidden: true });
  const scan = canScan() ? el("button", { class: "ghost", type: "button", onclick: () => void startScan(view, scan) }, t("phone.scan")) : null;
  return el(
    "div",
    { class: "card stack" },
    el("div", { class: "title" }, t("phone.computerAddTitle")),
    el("p", { class: "small muted add-lead" }, t("phone.computerAddLead")),
    scan,
    view,
    el("label", {}, t("phone.computerAddress"), address),
    el("label", {}, t("phone.code"), code.node),
    parts.addComputer,
  );
}

/** Whether this phone's browser reads QR codes with its camera (Chrome on Android does; Safari doesn't, and the button stays away). */
function canScan() {
  return typeof window !== "undefined" && "BarcodeDetector" in window && Boolean(navigator.mediaDevices?.getUserMedia);
}

/** Puts the camera down: leaving the page, Cancel, or a code read. */
export function scanCancel() {
  stopScan?.();
  stopScan = null;
}

/**
 * Reads the QR code Settings → Phone draws on the other computer, with the phone's camera, and adds
 * that computer: its address and pairing code are both in the code, so nothing is typed. The
 * picture never leaves the phone.
 * @param {HTMLDivElement} view
 * @param {HTMLButtonElement | null} button
 */
async function startScan(view, button) {
  scanCancel();
  state.actionError = "";
  update();
  /** @type {MediaStream} */
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false });
  } catch {
    state.actionError = t("phone.scanBlocked");
    update();
    return;
  }
  const video = el("video", { class: "scan-view", playsinline: "", muted: "" });
  video.srcObject = stream;
  let timer = 0;
  stopScan = () => {
    window.clearInterval(timer);
    for (const track of stream.getTracks()) track.stop();
    view.hidden = true;
    view.replaceChildren();
    if (button) button.hidden = false;
  };
  view.replaceChildren(video, el("p", { class: "small muted add-lead" }, t("phone.scanHint")), el("button", { class: "ghost", type: "button", onclick: scanCancel }, t("common.cancel")));
  view.hidden = false;
  if (button) button.hidden = true;
  try {
    await video.play();
    const detector = new /** @type {any} */ (window).BarcodeDetector({ formats: ["qr_code"] });
    let looking = false;
    timer = window.setInterval(async () => {
      if (looking || !video.isConnected) return;
      looking = true;
      try {
        /** @type {Array<{ rawValue?: string }>} */
        const found = await detector.detect(video);
        const link = found.map((item) => item.rawValue || "").find((text) => readAddress(text, window.location)?.code);
        if (link) {
          scanCancel();
          void add(link, "");
        }
      } catch {
        // A frame that couldn't be read: the next one is tried.
      } finally {
        looking = false;
      }
    }, 300);
  } catch {
    scanCancel();
    state.actionError = t("phone.scanFailed");
    update();
  }
}

/**
 * Adds the computer at an address once it says the code is its own, and shows it.
 * @param {string} typedAddress
 * @param {string} typedCode
 */
function add(typedAddress, typedCode) {
  return withBusy(async () => {
    const read = readAddress(typedAddress, window.location);
    if (!read) throw new Error(t("phone.computerAddressBad"));
    if (!read.url || computers().some((item) => item.url === read.url && item.token)) throw new Error(t("phone.computerSame"));
    // A pasted link carries its code; a code typed beside it wins.
    const given = typedCode.trim() || read.code;
    /** @type {{ computer?: string, key?: string }} */
    let answer;
    try {
      answer = await checkCode(given, read.url);
    } catch (err) {
      throw err.offline ? new Error(t("phone.computerUnreachable")) : err;
    }
    saveComputer({ url: read.url, token: keyFrom(answer, given), name: typeof answer.computer === "string" ? answer.computer.trim().slice(0, 80) : "" });
    showComputer(read.url);
  });
}
