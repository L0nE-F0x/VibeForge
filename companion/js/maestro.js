// @ts-check
// The desktop's Orchestrator view on the phone (src/ui/views/Orchestrator.tsx): the same
// conversation, plan cards and Running list, read from and sent to the computer. The planning CLI
// runs there; the page only shows what it said and passes on what the person says and taps.

import { call, post, withBusy } from "./api.js";
import { brandMark } from "./art.js";
import { editingIn, el, sheet } from "./dom.js";
import { micParts, paintMic } from "./mic.js";
import { setView } from "./pages.js";
import { pendingSteps, planCard, sizePrompts } from "./plan-card.js";
import { openSession } from "./session.js";
import { parts, state } from "./state.js";
import { stateLabel, t, tCount, words } from "./words.js";

/** @typedef {import("./state.js").PhoneOrchestrator} PhoneOrchestrator */
/** @typedef {import("./state.js").PhoneTurn} PhoneTurn */
/** @typedef {import("./state.js").PhoneRunning} PhoneRunning */
/** @typedef {import("./state.js").ThreadSummary} ThreadSummary */
/** @typedef {import("./state.js").OrchCheck} OrchCheck */

const MAX_ORCH_IMAGES = 4;
const MAX_ORCH_IMAGE_BYTES = 10 * 1024 * 1024;

/** @param {string | null | undefined} id */
export function engineLabel(id) {
  return state.orch?.engines.find((engine) => engine.id === id)?.label || id || "";
}

export function maestroPage() {
  parts.orchTurns = new Map();
  parts.orchTurnsKey = null;
  parts.planner = el("select", { class: "orch-planner", "aria-label": t("orch.planner"), onchange: () => void saveOrch({ engine: parts.planner.value }) });
  parts.plannerKey = null;
  parts.modes = ["plan", "go"].map((mode) => el("button", { class: "seg", type: "button", "data-mode": mode, "aria-pressed": "false", onclick: () => void saveOrch({ mode }) }, t(`orch.mode.${mode}`)));
  parts.threadsOpen = el(
    "button",
    {
      class: "ghost top-action",
      type: "button",
      onclick: () => {
        paintThreads();
        parts.threadsSheet.open();
      },
    },
    t("orch.threads"),
  );
  parts.threadsList = el("div", { class: "stack" });
  parts.threadsKey = null;
  parts.threadsSheet = sheet(t("orch.threads"), parts.threadsList);
  parts.memoryOpen = el("button", { class: "ghost top-action", type: "button", onclick: () => void openMemorySheet() }, t("orch.memoryTitle"));
  parts.memoryBox = el("textarea", { class: "orch-memory-area", placeholder: t("orch.memoryPlaceholder"), "aria-label": t("orch.memoryTitle") });
  parts.memorySave = el("button", { class: "btn", type: "button", onclick: () => void saveMemorySheet() }, t("common.save"));
  parts.memorySheet = sheet(t("orch.memoryTitle"), el("p", { class: "small faint" }, t("orch.memoryHint")), parts.memoryBox, el("div", { class: "actions" }, parts.memorySave));
  parts.newTalk = el("button", { class: "ghost top-action", type: "button", title: t("orch.newTip"), onclick: () => void newTalk() }, t("orch.new"));
  parts.runningOpen = el("button", { class: "ghost orch-running-open", type: "button", hidden: true, onclick: () => parts.runningSheet.open() });
  parts.runningList = el("div", { class: "orch-team" });
  parts.runningKey = null;
  parts.runningSheet = sheet(t("orch.team"), parts.runningList);
  parts.orchLoading = el("p", { class: "small faint" }, t("phone.loading"));
  parts.earlier = el("p", { class: "small faint orch-earlier", hidden: true });
  parts.startBody = el("p", { class: "muted" });
  parts.startHere = el(
    "div",
    { class: "orch-start", hidden: true },
    el("h2", {}, t("orch.empty.title")),
    parts.startBody,
  );
  parts.notReady = el("div", { class: "orch-problem", hidden: true });
  parts.turnList = el("div", { class: "orch-list" });
  parts.thinkingText = el("span", { class: "grow muted" });
  parts.thinkingStop = el("button", { class: "ghost small-btn", type: "button", onclick: () => void stopThinking() }, t("orch.stop"));
  parts.thinking = el("div", { class: "orch-turn from-vibeforge orch-thinking", hidden: true }, whoMark(), el("span", { class: "px working", "aria-hidden": "true" }), parts.thinkingText, parts.thinkingStop);
  parts.turns = el("div", { class: "orch-turns" }, parts.orchLoading, parts.earlier, parts.startHere, parts.notReady, parts.turnList, parts.thinking);
  parts.stickTurns = true;
  // Follow the conversation as it grows, unless the person scrolled up to read.
  parts.turns.addEventListener("scroll", () => {
    const node = parts.turns;
    parts.stickTurns = node.scrollHeight - node.scrollTop - node.clientHeight < 32;
  });
  parts.box = el("textarea", { id: "orch-say", placeholder: t("phone.orchPlaceholder"), "aria-label": t("orch.title") });
  parts.box.value = state.orchDraft;
  parts.box.addEventListener("input", () => {
    state.orchDraft = parts.box.value;
  });
  parts.box.addEventListener("paste", (event) => {
    const items = Array.from(event.clipboardData?.items ?? []);
    const files = items
      .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
      .map((item) => item.getAsFile())
      .filter(/** @return {file is File} */ (file) => Boolean(file));
    if (!files.length) return;
    event.preventDefault();
    void addOrchImages(files);
  });
  parts.orchImageCache = new Map();
  parts.orchImagePreview = el("img", { class: "orch-lightbox-img", alt: "" });
  parts.orchImageSheet = sheet(t("orch.attachImage"), parts.orchImagePreview);
  parts.orchImageStrip = el("div", { class: "orch-image-strip", hidden: true });
  parts.orchImageInput = el("input", {
    type: "file",
    accept: "image/png,image/jpeg,image/webp,image/gif",
    multiple: true,
    hidden: true,
    onchange: () => {
      const files = Array.from(parts.orchImageInput.files ?? []);
      parts.orchImageInput.value = "";
      if (files.length) void addOrchImages(files);
    },
  });
  parts.orchAttach = el(
    "button",
    {
      class: "ghost small-btn orch-attach",
      type: "button",
      title: t("orch.attachImage"),
      "aria-label": t("orch.attachImage"),
      onclick: () => parts.orchImageInput.click(),
    },
    t("orch.attachImage"),
  );
  paintOrchImages();
  micParts();
  parts.say = el("button", { class: "btn", type: "button", onclick: () => void askOrch() }, t("phone.send"));
  return el(
    "section",
    { class: "fit orch" },
    el("div", { class: "top" }, el("button", { class: "back", type: "button", onclick: () => setView("desk") }, t("phone.back")), el("h1", { class: "grow" }, t("orch.title")), parts.threadsOpen, parts.memoryOpen, parts.newTalk),
    el(
      "div",
      { class: "orch-head" },
      el("label", { class: "orch-planner-field" }, t("orch.planner"), parts.planner),
      el("div", { class: "segs", role: "group", "aria-label": t("orch.modeLabel") }, parts.modes),
    ),
    parts.runningOpen,
    parts.turns,
    el("div", { class: "card stack composer orch-composer" }, parts.orchImageInput, parts.orchImageStrip, parts.micNote, parts.box, el("div", { class: "actions" }, parts.orchAttach, parts.mic, parts.say)),
    parts.runningSheet,
    parts.threadsSheet,
    parts.memorySheet,
    parts.orchImageSheet,
  );
}

export function whoMark() {
  return el("span", { class: "orch-who", "aria-hidden": "true" }, brandMark());
}

export function updateMaestro() {
  if (!parts.turns) return;
  const orch = state.orch;
  paintPlanner();
  for (const button of parts.modes) {
    const on = orch?.mode === button.dataset.mode;
    button.classList.toggle("on", on);
    button.setAttribute("aria-pressed", String(on));
    button.disabled = state.busy || !orch;
  }
  parts.newTalk.disabled = state.busy || !orch?.turns.length;
  parts.threadsOpen.disabled = state.busy || !orch;
  parts.memoryOpen.disabled = state.busy || !orch;
  parts.memoryOpen.classList.toggle("on", Boolean(orch?.hasMemory));
  paintRunning();
  paintThreads();
  parts.orchLoading.hidden = Boolean(orch);
  parts.say.disabled = state.busy || !orch || orch.thinking;
  if (parts.orchAttach) parts.orchAttach.disabled = state.busy || !orch || orch.thinking || state.orchImages.length >= MAX_ORCH_IMAGES;
  paintMic();
  if (!orch) return;
  const label = engineLabel(orch.engineId);
  parts.earlier.hidden = !orch.earlier;
  if (orch.earlier) parts.earlier.textContent = tCount("phone.orchEarlier", orch.earlier);
  parts.startHere.hidden = orch.turns.length > 0 || orch.thinking;
  parts.startBody.textContent = t("orch.empty.body", { engine: label });
  parts.notReady.hidden = orch.engineReady;
  parts.notReady.textContent = t("phone.orchNotReady", { engine: label });
  const changed = paintTurns();
  parts.thinking.hidden = !orch.thinking;
  parts.thinkingText.textContent = orch.activity?.label
    ? t(`orch.work.${orch.activity.kind}`, { target: orch.activity.label })
    : t("orch.thinking", { engine: label });
  parts.thinkingStop.disabled = state.busy;
  for (const button of /** @type {NodeListOf<HTMLButtonElement>} */ (parts.turnList.querySelectorAll("button[data-act]"))) button.disabled = state.busy || button.dataset.off === "1";
  const key = JSON.stringify([orch.turns.length, orch.thinking, orch.engineReady, orch.activity?.kind, orch.activity?.label]);
  if (changed || key !== parts.orchTurnsKey) {
    parts.orchTurnsKey = key;
    if (parts.stickTurns && !editingIn(parts.turns)) parts.turns.scrollTop = parts.turns.scrollHeight;
  }
  // A link asked for one plan (the Android widget's waiting plan): it is brought into view once,
  // and the conversation stays there instead of following its end. A plan that has gone is let be.
  if (state.focusTurn) {
    const wanted = parts.orchTurns.get(state.focusTurn)?.node;
    state.focusTurn = "";
    if (wanted) {
      parts.stickTurns = false;
      wanted.scrollIntoView({ block: "start" });
    }
  }
}

/** @param {import("./state.js").Sheet} targetSheet */
function closeSheet(targetSheet) {
  /** @type {HTMLButtonElement | null} */ (targetSheet.querySelector(".sheet-close"))?.click();
}

function paintThreads() {
  const orch = state.orch;
  const threads = orch?.threads ?? [];
  const key = JSON.stringify([orch?.activeThreadId, threads, state.busy]);
  if (key === parts.threadsKey) return;
  parts.threadsKey = key;
  if (!threads.length) {
    parts.threadsList.replaceChildren(el("p", { class: "small faint" }, t("orch.threadsEmpty")));
    return;
  }
  const rows = threads.map((item) =>
    el(
      "div",
      { class: `orch-thread-row${item.id === orch?.activeThreadId ? " active" : ""}` },
      el(
        "button",
        {
          class: "orch-thread-open",
          type: "button",
          disabled: state.busy,
          onclick: () => void pickThread(item.id),
        },
        el("span", { class: "orch-thread-title" }, item.title),
        item.preview ? el("span", { class: "small faint" }, item.preview) : null,
      ),
      el(
        "button",
        {
          class: "ghost small-btn",
          type: "button",
          disabled: state.busy,
          onclick: () => void removeThread(item.id),
        },
        t("common.delete"),
      ),
    ),
  );
  parts.threadsList.replaceChildren(...rows);
}

/** @param {string} threadId */
async function pickThread(threadId) {
  closeSheet(parts.threadsSheet);
  await withBusy(() => post("/api/orchestrator/thread", { threadId }));
}

/** @param {string} threadId */
async function removeThread(threadId) {
  await withBusy(() => post("/api/orchestrator/deleteThread", { threadId }));
}

async function openMemorySheet() {
  parts.memoryBox.value = "";
  parts.memoryBox.disabled = true;
  parts.memorySave.disabled = true;
  parts.memorySheet.open();
  try {
    const res = /** @type {{ text?: string }} */ (await call("/api/orchestrator/memory"));
    parts.memoryBox.value = res.text || "";
  } finally {
    parts.memoryBox.disabled = false;
    parts.memorySave.disabled = false;
  }
}

async function saveMemorySheet() {
  const saved = await withBusy(() => post("/api/orchestrator/memory", { text: parts.memoryBox.value }));
  if (saved !== false) closeSheet(parts.memorySheet);
}

/** @param {OrchCheck} check */
function checkNode(check) {
  const title = t(check.kind === "lookup" ? "orch.chip.lookedUp" : check.kind === "verify" ? "orch.chip.verified" : "orch.chip.checked", { target: check.label });
  return el(
    "details",
    { class: "orch-check-detail" },
    el("summary", {}, `${title}${check.summary ? ` · ${check.summary}` : ""}`),
    check.details ? el("pre", { class: "orch-check-pre" }, check.details) : null,
  );
}

/** The planner list, rebuilt only when it changes and never while it is open. */
function paintPlanner() {
  const select = parts.planner;
  const orch = state.orch;
  select.disabled = state.busy || !orch;
  if (!orch || document.activeElement === select) return;
  const key = JSON.stringify([orch.planners, orch.engineId]);
  if (key === parts.plannerKey) return;
  parts.plannerKey = key;
  const options = orch.planners.map((engine) => el("option", { value: engine.id }, `${engine.label}${engine.available ? "" : ` ${t("common.notOnPath")}`}`));
  if (!orch.planners.some((engine) => engine.id === orch.engineId)) options.unshift(el("option", { value: orch.engineId }, orch.engineId));
  select.replaceChildren(...options);
  select.value = orch.engineId;
}

/**
 * The conversation, one node per turn, rebuilt only when that turn changed. A plan card someone
 * is typing in waits until they leave it. Returns whether anything moved.
 */
function paintTurns() {
  const orch = /** @type {PhoneOrchestrator} */ (state.orch);
  // A plan card names CLIs, workspaces and running terminals, so it is redrawn when those change.
  const context = JSON.stringify([orch.engines, orch.workspaces, orch.copies, orch.running.map((item) => [item.ptyId, item.label]), [...pendingSteps]]);
  const seen = new Set();
  /** @type {HTMLElement | null} */
  let previous = null;
  let changed = false;
  for (const turn of orch.turns) {
    seen.add(turn.id);
    const key = JSON.stringify(turn) + context;
    let entry = parts.orchTurns.get(turn.id);
    let fresh = false;
    // A card is left alone while someone types in it, unless its plan has gone ahead (or been dropped) meanwhile.
    if (!entry || (entry.key !== key && !(turn.plan === "waiting" && editingIn(entry.node)))) {
      const node = turnNode(turn);
      if (entry) entry.node.replaceWith(node);
      entry = { key, node };
      parts.orchTurns.set(turn.id, entry);
      fresh = true;
    }
    /** @type {ChildNode | null} */
    const want = previous ? previous.nextSibling : parts.turnList.firstChild;
    if (entry.node !== want) {
      parts.turnList.insertBefore(entry.node, want);
      fresh = true;
    }
    // A box can only be measured once it is on the page.
    if (fresh) sizePrompts(entry.node);
    changed ||= fresh;
    previous = entry.node;
  }
  for (const [id, entry] of parts.orchTurns) {
    if (seen.has(id)) continue;
    entry.node.remove();
    parts.orchTurns.delete(id);
    changed = true;
  }
  return changed;
}

/**
 * VibeForge's own word about a CLI Maestro started or told: its turn ended (with the start of its answer), or it closed.
 * @param {NonNullable<PhoneTurn["note"]>} note
 */
function noteNode(note) {
  const orch = /** @type {PhoneOrchestrator} */ (state.orch);
  const running = orch.running.find((item) => item.ptyId === note.ptyId);
  const said = el(
    "span",
    { class: "orch-said" },
    t(note.kind === "finished" ? "orch.note.finished" : note.kind === "waiting" ? "orch.note.waiting" : "orch.note.ended", { engine: note.engine, workspace: note.workspace }),
    note.changes ? el("span", { class: "faint" }, ` · ${note.changes}`) : null,
  );
  const open = running
    ? el("button", { class: "ghost small-btn", type: "button", "data-act": "open", disabled: state.busy, onclick: () => openSession({ ptyId: running.ptyId, runId: running.runId || "" }) }, t("phone.orchOpen"))
    : note.runId
      ? el("button", { class: "ghost small-btn", type: "button", "data-act": "open", disabled: state.busy, onclick: () => openSession({ ptyId: "", runId: /** @type {string} */ (note.runId) }) }, t("phone.orchOpen"))
      : null;
  const reply = note.reply ? el("span", { class: "orch-prompt-text" }, note.reply) : null;
  return el("div", { class: "orch-turn from-vibeforge orch-note" }, whoMark(), el("div", { class: "orch-body" }, said, reply, open ? el("div", { class: "orch-step-actions" }, open) : null));
}

/** @param {Blob} file @returns {Promise<string | null>} */
function readOrchImage(file) {
  if (!file.size || file.size > MAX_ORCH_IMAGE_BYTES) return Promise.resolve(null);
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : null);
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(file);
  });
}

/** @param {File[]} files */
async function addOrchImages(files) {
  const urls = (await Promise.all(files.slice(0, MAX_ORCH_IMAGES).map(readOrchImage))).filter(/** @return {url is string} */ (url) => Boolean(url));
  if (!urls.length) return;
  const remaining = MAX_ORCH_IMAGES - state.orchImages.length;
  if (remaining <= 0) return;
  state.orchImages = [...state.orchImages, ...urls.slice(0, remaining)];
  paintOrchImages();
}

function paintOrchImages() {
  if (!parts.orchImageStrip) return;
  parts.orchImageStrip.hidden = state.orchImages.length === 0;
  parts.orchImageStrip.replaceChildren(
    ...state.orchImages.map((src, idx) =>
      el(
        "div",
        { class: "orch-image-thumb" },
        el("img", { src, alt: "" }),
        el(
          "button",
          {
            class: "orch-image-remove",
            type: "button",
            "aria-label": t("orch.removeImage"),
            onclick: () => {
              state.orchImages = state.orchImages.filter((_, at) => at !== idx);
              paintOrchImages();
            },
          },
          "×",
        ),
      ),
    ),
  );
  if (parts.orchAttach) parts.orchAttach.disabled = state.busy || !state.orch || state.orch.thinking || state.orchImages.length >= MAX_ORCH_IMAGES;
}

/** @param {string} name @param {HTMLElement} wrap */
async function fillTurnImage(name, wrap) {
  let url = parts.orchImageCache.get(name);
  if (url === undefined) {
    try {
      const res = /** @type {{ dataUrl?: string }} */ (await call(`/api/orchestrator/image?name=${encodeURIComponent(name)}`));
      url = typeof res.dataUrl === "string" ? res.dataUrl : null;
    } catch {
      url = null;
    }
    parts.orchImageCache.set(name, url);
  }
  if (!url || !wrap.isConnected) return;
  wrap.appendChild(
    el(
      "button",
      {
        class: "orch-turn-img-btn",
        type: "button",
        onclick: () => {
          parts.orchImagePreview.src = /** @type {string} */ (url);
          parts.orchImageSheet.open();
        },
      },
      el("img", { src: url, alt: "" }),
    ),
  );
}

/** The words for a yes the planner heard (`confirmed` on a turn), as the desktop says them: CONFIRMED_KEY in src/shared/orchestrator.ts. */
const CONFIRMED_KEY = { ran: "core.orchConfirmedRan", risky: "core.orchConfirmedRisky", read: "core.orchConfirmedRead", fix: "core.orchConfirmedFix" };

/**
 * What Viby said in a turn. A sentence VibeForge wrote itself, rather than the planner, is shown in
 * the phone's language; the English it was saved in stands in when the computer sent no such word.
 * @param {PhoneTurn} turn
 */
function saidText(turn) {
  const key = turn.confirmed ? CONFIRMED_KEY[turn.confirmed] : undefined;
  return (key && words[key]) || turn.text;
}

/** @param {PhoneTurn} turn */
function turnNode(turn) {
  if (turn.from === "you") {
    const imgs = turn.images?.length ? el("div", { class: "orch-turn-images" }) : null;
    if (imgs && turn.images) {
      for (const name of turn.images) void fillTurnImage(name, imgs);
    }
    return el("div", { class: "orch-turn from-you" }, imgs, turn.text ? el("span", { class: "orch-said" }, turn.text) : null);
  }
  if (turn.note) return noteNode(turn.note);
  const orch = /** @type {PhoneOrchestrator} */ (state.orch);
  const label = engineLabel(turn.by || orch.engineId);
  const said = turn.problem
    ? el("div", { class: "orch-problem-text" }, el("span", {}, t(`orch.problem.${turn.problem}`, { engine: label })), turn.detail ? el("span", { class: "orch-detail" }, turn.detail) : null)
    : turn.text
      ? el("span", { class: "orch-said" }, saidText(turn))
      : null;
  const checks = turn.checks?.length ? el("div", { class: "orch-checks" }, turn.checks.map((check) => checkNode(check))) : null;
  return el("div", { class: "orch-turn from-vibeforge" }, whoMark(), el("div", { class: "orch-body" }, said, checks, turn.steps ? planCard(turn) : null));
}

async function askOrch() {
  const said = parts.box.value.trim();
  const images = state.orchImages.slice();
  if ((!said && !images.length) || !state.orch || state.orch.thinking) return;
  parts.stickTurns = true;
  const sent = await withBusy(async () => {
    await post("/api/orchestrator/ask", { text: said, ...(images.length ? { images } : {}) });
    return true;
  });
  if (!sent) return;
  state.orchDraft = "";
  state.orchImages = [];
  paintOrchImages();
  if (parts.box) parts.box.value = "";
}

function stopThinking() {
  return withBusy(() => post("/api/orchestrator/stop", {}));
}

function newTalk() {
  return withBusy(() => post("/api/orchestrator/new", {}));
}

/** @param {{ engine?: string, mode?: string }} patch */
function saveOrch(patch) {
  return withBusy(() => post("/api/orchestrator/settings", patch));
}

/** "Running · 3": every coding CLI on the computer, the Orchestrator's first. The list opens over the page. */
function paintRunning() {
  const running = state.orch?.running ?? [];
  const own = running.filter((item) => item.orchestrated);
  parts.runningOpen.hidden = running.length === 0;
  const key = JSON.stringify([running, state.busy]);
  if (key === parts.runningKey) return;
  parts.runningKey = key;
  const lit = running.some((item) => item.state === "working") ? "working" : "waiting";
  parts.runningOpen.replaceChildren(
    .../** @type {HTMLElement[]} */ ([
      el("span", { class: `px ${lit}`, "aria-hidden": "true" }),
      el("span", { class: "grow" }, `${t("orch.team")} · ${running.length}`),
      own.length ? el("span", { class: "small faint" }, `${t("orch.mine")} · ${own.length}`) : null,
      el("span", { class: "chev", "aria-hidden": "true" }),
    ].filter(Boolean)),
  );
  const rows = running.map((item) =>
    el(
      "div",
      { class: `orch-member ${item.state}` },
      el(
        "button",
        { class: "orch-member-open", type: "button", onclick: () => openSession({ ptyId: item.ptyId, runId: item.runId || "" }) },
        el("span", { class: `px ${item.state}`, "aria-hidden": "true" }),
        el(
          "span",
          { class: "grow orch-member-copy" },
          el("span", { class: "title" }, item.name, item.orchestrated ? el("span", { class: "orch-mine" }, ` · ${t("orch.mine")}`) : null),
          el("span", { class: "small muted" }, item.workspace),
        ),
        el("span", { class: `pill ${item.state}` }, stateLabel(item.state)),
      ),
      el("button", { class: "ghost small-btn", type: "button", disabled: state.busy, onclick: () => void stopOne(item) }, item.stop === "interrupt" ? t("phone.interrupt") : t("orch.stopOne")),
    ),
  );
  parts.runningList.replaceChildren(
    .../** @type {HTMLElement[]} */ ([
      own.length ? el("div", { class: "orch-team-head" }, el("button", { class: "ghost danger", type: "button", disabled: state.busy, onclick: () => void stopAll(own) }, t("orch.stopAll"))) : null,
      running.length ? null : el("p", { class: "small faint" }, t("orch.teamEmpty")),
      ...rows,
    ].filter(Boolean)),
  );
}

/**
 * Stop as the phone stops: a run's terminal closes; a CLI typed into a shell is interrupted and the shell stays.
 * @param {PhoneRunning} item
 */
async function stopOne(item) {
  if (!window.confirm(item.stop === "interrupt" ? t("phone.askInterrupt") : t("phone.askStop"))) return;
  await withBusy(() => post("/api/stop", { ptyId: item.ptyId }));
}

/**
 * Stop all: only the CLIs the Orchestrator started, as on the desktop, which asks first too.
 * @param {PhoneRunning[]} own
 */
async function stopAll(own) {
  if (!window.confirm(`${tCount("orch.stopAllTitle", own.length)}\n\n${t("orch.stopAllBody")}`)) return;
  await withBusy(() => Promise.all(own.map((item) => post("/api/stop", { ptyId: item.ptyId }))));
}
