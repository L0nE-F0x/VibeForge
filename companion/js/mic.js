// @ts-check
// Talking to the Orchestrator. The mic records on the phone and the computer's own whisper hears it
// (Settings → Voice there), told the same names as the desktop's box. The words land in the box and
// wait for Send. Tap to start and tap again to stop, or hold and let go: src/ui/mic.ts on the desktop.

import { forget } from "./api.js";
import { glyph } from "./art.js";
import { el } from "./dom.js";
import { update } from "./pages.js";
import { parts, state } from "./state.js";
import { t } from "./words.js";

/** A press shorter than this is a tap: it keeps listening until the next tap (MIC_TAP_MS on the desktop). */
const MIC_TAP_MS = 350;
/** A recording stops by itself after this long, as on the computer. */
const MIC_MAX_SECONDS = 180;
/** What whisper takes: 16 kHz mono. */
const HEAR_RATE = 16000;
const METER_CELLS = 10;
/** @type {Record<string, string>} */
const EMPTY_HEARD = { short: "phone.micShort", silent: "voice.empty.silent", nothing: "voice.empty.nothing" };

/**
 * @typedef {object} Recording
 * @property {"starting" | "recording" | "hearing"} phase
 * @property {boolean} latched
 * @property {boolean} finish
 * @property {Float32Array[]} chunks
 * @property {number} length
 * @property {number} level
 * @property {AudioContext | null} ctx
 * @property {MediaStream | null} stream
 * @property {MediaStreamAudioSourceNode | null} source
 * @property {AudioWorkletNode | null} node
 * @property {number} timer
 * @property {AbortController | null} upload While it is heard: the request, so Cancel can let go of it.
 */

/** The recording, while there is one: starting (the phone asks for the mic), recording, or being heard. @type {Recording | null} */
let mic = null;
/** A short note after a recording that gave no words. */
let micSaid = { text: "", until: 0 };

/** The mic's button and the note above the box while it listens, for the Orchestrator's page. */
export function micParts() {
  parts.micMeter = el("span", { class: "meter", "aria-hidden": "true" }, Array.from({ length: METER_CELLS }, () => el("i")));
  parts.micBusy = el("span", { class: "px working", "aria-hidden": "true" });
  parts.micWord = el("strong", {});
  parts.micClock = el("span", { class: "mic-clock" });
  parts.micHint = el("span", { class: "small faint mic-hint" });
  parts.micCancel = el("button", { class: "ghost small-btn mic-cancel", type: "button", onclick: () => micCancel(true) }, t("common.cancel"));
  parts.micNote = el("div", { class: "mic-note", hidden: true, role: "status", "aria-live": "polite" }, parts.micMeter, parts.micBusy, parts.micWord, parts.micClock, parts.micHint, parts.micCancel);
  parts.mic = micButton();
}

function micSupported() {
  // Not every phone's browser has these, and none lends the mic to a page that isn't secure.
  return Boolean(window.isSecureContext && /** @type {Partial<MediaDevices> | undefined} */ (navigator.mediaDevices)?.getUserMedia && window.AudioContext && window.AudioWorkletNode);
}

function micButton() {
  const button = el("button", { class: "ghost mic", type: "button", hidden: true, "aria-label": t("phone.mic"), title: t("phone.mic") }, glyph("mic"));
  /** @type {{ at: number, started: boolean } | null} */
  let press = null;
  button.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || button.disabled) return;
    event.preventDefault();
    try {
      button.setPointerCapture(event.pointerId);
    } catch {
      /* not every pointer can be captured */
    }
    // A press while it listens is the tap that stops it, on release.
    press = { at: Date.now(), started: !mic };
    if (!mic) micBegin();
  });
  button.addEventListener("pointerup", (event) => {
    const held = press;
    press = null;
    if (held && event.button === 0) micRelease(held, false);
  });
  button.addEventListener("pointercancel", () => {
    const held = press;
    press = null;
    if (held) micRelease(held, true);
  });
  // Enter or Space on the focused button: a tap, with no hold to measure.
  button.addEventListener("click", (event) => {
    if (event.detail !== 0) return;
    if (mic) void micFinish();
    else {
      micBegin();
      if (mic) /** @type {Recording} */ (mic).latched = true;
    }
  });
  button.addEventListener("contextmenu", (event) => event.preventDefault());
  return button;
}

/**
 * Letting go: a tap (or a press the phone's own question about the mic interrupted) keeps listening; a hold, or the tap that ends it, finishes.
 * @param {{ at: number, started: boolean }} held
 * @param {boolean} cancelled
 */
function micRelease(held, cancelled) {
  if (cancelled) {
    micCancel();
    return;
  }
  const current = mic;
  if (!current || current.phase === "hearing") return;
  if (held.started && Date.now() - held.at < MIC_TAP_MS) {
    current.latched = true;
    paintMic();
    return;
  }
  if (current.phase === "starting") {
    micCancel();
    return;
  }
  void micFinish();
}

/** @param {Recording} current */
function micSeconds(current) {
  return current.ctx ? current.length / current.ctx.sampleRate : 0;
}

/**
 * How full the meter is: the loudness of the last stretch on -60…0 dBFS (meterLevel on the computer).
 * @param {Float32Array} samples
 */
function loudness(samples) {
  let sum = 0;
  for (let i = 0; i < samples.length; i += 1) sum += samples[i] * samples[i];
  const value = Math.sqrt(sum / Math.max(1, samples.length));
  if (value <= 0) return 0;
  return Math.max(0, Math.min(1, (20 * Math.log10(value) + 60) / 60));
}

function micBegin() {
  if (mic) return;
  /** @type {Recording} */
  const mine = { phase: "starting", latched: false, finish: false, chunks: [], length: 0, level: 0, ctx: null, stream: null, source: null, node: null, timer: 0, upload: null };
  micSaid = { text: "", until: 0 };
  try {
    // Made inside the tap itself, or iOS keeps it silent.
    mine.ctx = new AudioContext();
    void mine.ctx.resume().catch(() => undefined);
  } catch {
    showMicNote(t("phone.micFailed"));
    return;
  }
  mic = mine;
  paintMic();
  const ctx = mine.ctx;
  void (async () => {
    try {
      mine.stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      await ctx.audioWorklet.addModule("/mic-worklet.js");
      if (mic !== mine) {
        closeMic(mine);
        return;
      }
      mine.source = ctx.createMediaStreamSource(mine.stream);
      mine.node = new AudioWorkletNode(ctx, "vibeforge-mic");
      mine.node.port.onmessage = (event) => {
        mine.chunks.push(event.data);
        mine.length += event.data.length;
        mine.level = loudness(event.data);
      };
      mine.source.connect(mine.node);
      // Connected through to the speakers so it keeps running; it writes nothing, so nothing plays.
      mine.node.connect(ctx.destination);
      if (ctx.state === "suspended") await ctx.resume();
      if (mic !== mine) {
        closeMic(mine);
        return;
      }
      mine.phase = "recording";
      mine.timer = window.setInterval(() => {
        if (mic !== mine) return;
        if (micSeconds(mine) >= MIC_MAX_SECONDS) void micFinish();
        else paintMic();
      }, 200);
      paintMic();
      if (mine.finish) void micFinish();
    } catch (err) {
      closeMic(mine);
      if (mic !== mine) return;
      mic = null;
      showMicNote(err && err.name === "NotAllowedError" ? t("phone.micBlocked") : t("phone.micFailed"));
    }
  })();
}

/**
 * Lets go of the microphone and the audio it went through.
 * @param {Recording} current
 */
function closeMic(current) {
  window.clearInterval(current.timer);
  try {
    current.source?.disconnect();
    current.node?.disconnect();
    if (current.node) current.node.port.onmessage = null;
  } catch {
    /* already disconnected */
  }
  for (const track of current.stream?.getTracks() || []) track.stop();
  void current.ctx?.close().catch(() => undefined);
}

/**
 * Puts the mic down. A recording is dropped; one already sent to be heard is let go of only when
 * Cancel itself was tapped (`heard`): leaving the page lets its words still land in the box.
 * @param {boolean} [heard]
 */
export function micCancel(heard = false) {
  const current = mic;
  if (!current) return;
  if (current.phase === "hearing") {
    if (!heard) return;
    current.upload?.abort();
    mic = null;
    paintMic();
    return;
  }
  mic = null;
  closeMic(current);
  paintMic();
}

/**
 * How long hearing a recording may take: the upload on a slow link, then whisper on the computer.
 * A minute at least, and more for a long recording (at 50 KB/s for the upload).
 * @param {number} bytes
 */
export function hearTimeout(bytes) {
  return Math.max(60_000, 30_000 + Math.ceil(bytes / 50));
}

/**
 * The recording as whisper wants it: 16 kHz mono signed 16-bit, each output sample the average of the input it covers.
 * @param {Float32Array[]} chunks
 * @param {number} length
 * @param {number} rate
 */
function toPcm(chunks, length, rate) {
  const all = new Float32Array(length);
  let at = 0;
  for (const chunk of chunks) {
    all.set(chunk.subarray(0, Math.min(chunk.length, length - at)), at);
    at += chunk.length;
  }
  const ratio = rate / HEAR_RATE;
  // The cap is checked every 200 ms, so a recording that reached it runs a little over: the computer takes three minutes exactly.
  const out = new Int16Array(Math.min(Math.floor(length / ratio), HEAR_RATE * MIC_MAX_SECONDS));
  for (let i = 0; i < out.length; i += 1) {
    const start = Math.floor(i * ratio);
    const end = Math.min(length, Math.max(start + 1, Math.floor((i + 1) * ratio)));
    let sum = 0;
    for (let j = start; j < end; j += 1) sum += all[j];
    const value = Math.max(-1, Math.min(1, sum / (end - start)));
    out[i] = value < 0 ? value * 0x8000 : value * 0x7fff;
  }
  return out;
}

/**
 * Dictated words joined onto what is already in the box, with one space between (joinDictation on the desktop).
 * @param {string} before
 * @param {string} said
 */
function joinDictation(before, said) {
  if (!before.trim()) return said;
  return /\s$/.test(before) ? before + said : `${before} ${said}`;
}

async function micFinish() {
  const mine = mic;
  if (!mine || mine.phase === "hearing") return;
  if (mine.phase === "starting") {
    mine.finish = true;
    return;
  }
  mine.phase = "hearing";
  if (mine.node) {
    mine.node.port.postMessage({ flush: true });
    await new Promise((resolve) => window.setTimeout(resolve, 20));
  }
  closeMic(mine);
  paintMic();
  try {
    const pcm = toPcm(mine.chunks, mine.length, /** @type {AudioContext} */ (mine.ctx).sampleRate);
    const upload = new AbortController();
    mine.upload = upload;
    const limit = window.setTimeout(() => upload.abort(), hearTimeout(pcm.byteLength));
    let response;
    try {
      response = await fetch("/api/orchestrator/hear", { method: "POST", headers: { Authorization: `Bearer ${state.token}`, "Content-Type": "application/octet-stream" }, body: pcm, signal: upload.signal });
    } catch {
      // Cancel let go of it: nothing to say.
      if (mic !== mine) return;
      throw new Error(upload.signal.aborted ? t("phone.timedOut") : t("phone.offline"));
    } finally {
      window.clearTimeout(limit);
    }
    const body = await response.json().catch(() => ({}));
    if (mic !== mine) return;
    if (response.status === 401) {
      forget();
      return;
    }
    if (!response.ok) throw new Error(body.error || t("phone.error.failed"));
    if (body.text) {
      const box = state.view === "maestro" ? parts.box : null;
      state.orchDraft = joinDictation(box ? box.value : state.orchDraft, body.text);
      if (box) box.value = state.orchDraft;
    } else showMicNote(t(EMPTY_HEARD[body.empty] || "voice.empty.nothing"));
  } catch (err) {
    state.actionError = err.message;
    update();
  } finally {
    if (mic === mine) mic = null;
    paintMic();
  }
}

/** @param {string} text */
function showMicNote(text) {
  micSaid = { text, until: Date.now() + 6000 };
  paintMic();
  window.setTimeout(paintMic, 6100);
}

export function paintMic() {
  const button = parts.mic;
  if (!button || state.view !== "maestro" || !button.isConnected) return;
  const phase = mic?.phase ?? "idle";
  button.hidden = !mic && !(state.orch?.hear && micSupported());
  if (button.dataset.phase !== phase) {
    button.dataset.phase = phase;
    button.replaceChildren(phase === "hearing" ? el("span", { class: "px working", "aria-hidden": "true" }) : glyph(phase === "recording" ? "stop" : "mic"));
  }
  button.classList.toggle("live", phase === "recording" || phase === "starting");
  button.setAttribute("aria-pressed", String(phase === "recording"));
  button.disabled = phase === "hearing";
  // What a tap does now, for a screen reader as for the eye.
  const label = phase === "hearing" ? t("voice.transcribing") : phase === "idle" ? t("phone.mic") : t("phone.micStop");
  if (button.getAttribute("aria-label") !== label) {
    button.setAttribute("aria-label", label);
    button.title = label;
  }
  const note = parts.micNote;
  const listening = phase === "recording" || phase === "starting";
  const said = !mic && micSaid.text && Date.now() < micSaid.until;
  note.hidden = !listening && phase !== "hearing" && !said;
  note.classList.toggle("said", Boolean(said));
  parts.micMeter.hidden = !listening;
  parts.micBusy.hidden = phase !== "hearing";
  parts.micClock.hidden = !listening;
  // Cancel stays while it is heard: a link that stalls would otherwise leave the box waiting.
  parts.micCancel.hidden = !listening && phase !== "hearing";
  if (listening && mic) {
    const lit = Math.round((mic.level || 0) * METER_CELLS);
    [...parts.micMeter.children].forEach((cell, index) => {
      cell.className = index < lit ? (index >= METER_CELLS - 2 ? "hot" : "on") : "";
    });
    const seconds = Math.floor(micSeconds(mic));
    parts.micWord.textContent = t("voice.listening");
    parts.micClock.textContent = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
    parts.micHint.textContent = mic.latched || phase === "starting" ? t("phone.micTap") : t("phone.micHold");
  } else if (phase === "hearing") {
    parts.micWord.textContent = t("voice.transcribing");
    parts.micHint.textContent = "";
  } else if (said) {
    parts.micWord.textContent = "";
    parts.micHint.textContent = micSaid.text;
  }
}
