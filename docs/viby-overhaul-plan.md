# Viby (Orchestrator) Overhaul Audit & Plan

**Branch:** `vibeforge/viby-massive-overhaul`  
**Baseline:** `v3.8.0` (`4f10575`) — `typecheck` (5 projects), `biome lint` (456 files), `vitest` (131 files, 1,205 passing tests in 33.26s).

## 1. End-to-End Architecture & Pipeline Trace

Viby (also referred to as Vibe / Maestro) operates across five coupled stages:

1. **Voice & Call Input**: `electron/voice.ts` (`Voice` & `openEar`) + `src/core/voice.ts` (`Endpointer`, `wavFile`, `cleanTranscript`) + `src/core/call.ts` (`Segmenter`, `CALL_SILENCE_MS`, `callWord`) capture 16 kHz mono s16le PCM via PipeWire (`pw-record` + optional PipeWire AEC), transcribe via warm `whisper-server` / `sherpa-onnx` stdio worker / `whisper-cli`, and filter speaker echoes (`echoes`).
2. **Instant Local Reflexes & Navigation**: `src/shared/orchestrator-reflex.ts` (`resolveLocalReflex`), `src/core/call.ts` (`quickNav`), and `src/core/service/orchestrator.ts` (`quickAct`, `quickShow`) intercept unambiguous single-intent commands (slash commands, waiting-plan approvals/cancels, undo, mark-reviewed, memory append, stop-all, navigation) without invoking an LLM CLI.
3. **Context Assembly & Planning Turn**: `OrchestratorDesk.context()` / `buildContext()` (`src/core/service/orchestrator.ts`) gathers workspaces, available coding CLIs, live PTYs + terminal prompts (`detectWaitingPrompt`), review copies, agents, skills, tasks, routines, chats, recent runs, settings, and `viby.md` memory. `orchestratorRules()` (`src/core/orchestrator.ts`) renders the system prompt and `brainArgs()` builds headless invocations for Grok Build, Claude Code, Codex, and Antigravity CLI, executed via `spawnBrain`.
4. **Parsing, Entity Resolution, Multi-Round Inspection & Verification**: `readBrainOutput()` extracts structured output or embedded JSON (`jsonObjectsIn` / `asPlan`), `resolvePlan()` maps natural names to VibeForge IDs (`matchName`), `stepIssue()` validates readiness, and `OrchestratorDesk.think()` runs up to `MAX_INSPECT_ROUNDS = 3` automatic `lookup`/`inspect` loops before enforcing Decision D1 (`fromReading`, `holdsForGo`, `safeInCall`) and either holding for `Go` or starting immediately.
5. **Step Execution & Spoken Reply**: `OrchestratorDesk.runSteps()` executes steps sequentially (pausing at `after: true` barriers via `waitForChainedPty`), `Speaker` (`electron/speech.ts`) streams sentence chunks through Piper (`spawnStandby` / `pw-play`), and desktop/phone UIs (`Orchestrator.tsx`, `OrchestratorConfirm.tsx`, `OrchestratorChips.tsx`, `VibyComposer.tsx`, `companion/js/plan-card.js`) render live progress and confirmation cards.

## 2. Audited Weaknesses (By Priority Goal)

### Goal 1 — Accuracy
- **Brittle Exact/Substring Name Matching (`matchName` in `src/core/orchestrator.ts`, `findMatch` in `src/shared/orchestrator-reflex.ts`)**: Only exact squash, prefix, substring `includes`, and whole-word matching exist. A single-character STT typo, adjacent transposition, missing space, or phonetic homophone (`"Star Leger"`, `"Cloud Code"`, `"Code X"`, `"Grock"`, `"Anti gravity"`, `"Oh Marchy"`, `"Hyperland"`, `"VibeForje"`) fails completely, flagging `stepIssue` or dropping to clarification.
- **Unstripped `@Mentions` & Narrow Composer STT Vocabulary**: `VibyComposer.tsx` inserts `@Workspace` / `@Agent` / `@CLI` tokens that are not stripped in `matchName` / `resolveLocalReflex`, and desktop composer `orchestratorVoiceWords` only passes workspace names rather than agents, CLIs, skills, routines, and common homophone anchors.
- **Strict JSON Extraction Without Structural Repair**: `readBrainOutput` / `jsonObjectsIn` / `asPlan` fail on markdown-fenced JSON, trailing commas, unescaped control newlines/tabs inside strings, wrapped `{ plan: ... }` / `{ output: ... }` envelopes, common key aliases (`message`/`reply` -> `say`, `actions` -> `steps`, `type` -> `kind`, `cli` -> `engine`, `path`/`dir` -> `folder`), or comma-separated string lists for `places`/`skills`/`agents`.
- **No Auto-Repair Retry on Malformed Output**: When a planner CLI exits cleanly (`code === 0`) with unparseable output or unsupported step kinds (`unknownKinds`), `OrchestratorDesk.think()` fails immediately with `problem: "unreadable"` instead of performing a fast 1-shot validation repair turn.

### Goal 2 — Speed
- **Cold Planner Process Startup Per Turn**: Every `think()` turn spawns a brand-new CLI process via `spawnBrain`, incurring cold Node/Go/Rust startup latency on consecutive turns even when Claude Code supports multi-turn `--input-format stream-json --output-format stream-json`.
- **Sequential Sentence Synthesis in `Speaker` (`electron/speech.ts`)**: `Speaker.next()` waits for `pw-play` to close on sentence chunk *N* before spawning/feeding Piper for chunk *N+1*, creating audible inter-sentence gaps, and reads `${voice}.json` synchronously on every chunk.
- **Untrimmed Silence & Unadaptive Endpointing (`src/core/voice.ts`, `electron/voice.ts`, `src/core/call.ts`)**: Dictated PCM retains full leading/trailing room silence through STT inference, and `Segmenter` always waits the full `CALL_SILENCE_MS` (700 ms) even after a crisp short command ends cleanly in deep silence.
- **Context Build & Prompt Overhead (`src/core/service/orchestrator.ts`)**: `buildContext()` runs `isGitRepo()` across every workspace and `listThemes()` on every 1.5 s cache miss, and serializes up to 25 tasks / 20 chats / 15 runs even when idle or irrelevant.
- **Strictly Serial Wave Execution**: `runSteps()` awaits every `start` step sequentially in a `for...of` loop (serially invoking `git worktree add` + `startEngine`) even when multiple independent `start` steps in the same wave target already-known workspaces.

### Goal 3 — Reliability & Diagnostics
- **Premature Chain Settle on Interactive TUI Prompts (`waitForChainedPty`)**: If a chained CLI briefly enters `working=true` and pauses on a folder-trust or tool-approval prompt (`working=false`), `chainTimers` resolves the waiter as `true` after `chainSettleMs` (1.2 s), causing downstream `after: true` `verify`/`apply`/`tell` steps to run against a stalled CLI. Additionally, `waitForChainedPty` has no bounded max wait timeout (`chainMaxWaitMs`).
- **Barge-In / Concurrent `ask()` Race**: If `ask()` arrives immediately after `stopThinking()` aborts a slow planner process whose `finally` cleanup hasn't completed yet, `if (this.thinking)` rejects with `"Viby is still answering. Wait for it, or stop it."`.
- **Silent `Call.turn()` Failure Surfacing (`electron/call.ts`)**: Errors inside `Call.turn()` update `this.said` without setting `this.error` or notifying the UI via `this.changed()`.
- **No Privacy-Safe Performance/Failure Telemetry**: There is no structured turn timing breakdown (context ms, planner ms, exec ms, repair retries, failure outcomes) for debugging or `"diagnostics"` inspection.

### Goal 4 — Expanded Capabilities & Context Memory
- **Loss of Entity/Pronoun Continuity on Viby View (`lookingLine`)**: When the user stays in the Viby tab (`looking.view === "orchestrator"`), `lookingLine()` returns `""`, so Turn 2 follow-ups (`"run tests there"`, `"tell it to check types"`, `"pause that routine"`) lack explicit entity anchoring unless the CLI's resumed transcript recalls IDs accurately.
- **Narrow Local Reflexes & Workbench Parity Gaps**: Common crisp operations (`/diagnostics`, `"pause routine X"`, `"switch theme to Y"`, `"/trust"` on a single waiting folder-trust prompt) still hit the LLM planner, and VibeForge lacks `workbench` actions for `open-folder`, `focus-next` / `focus-prev` panes, `check-updates`, and `run` `copy-markdown`.

### Goal 5 — Computer Use
- **No Desktop / App UI Observation or Control**: Viby cannot inspect non-terminal desktop windows, capture desktop/app-UI screenshots for visual reasoning, query interactive VibeForge/Dock DOM controls, or safely propose pointer/keyboard/window actions on Omarchy (Wayland/Hyprland) or X11.

## 3. Prioritized Implementation & Safety Plan

1. **Commit 2 — Accuracy Overhaul**:
   - Add `src/shared/orchestrator-fuzzy.ts` (Damerau-Levenshtein similarity, phonetic skeleton normalization, homophone/alias dictionary, acronym match, `@` stripping, strict ambiguity margin).
   - Add `src/shared/orchestrator-repair.ts` (tolerant JSON extraction, structural unwrapping & field aliasing, `extractEarlySay`).
   - Integrate into `matchName`, `readBrainOutput`, `resolveLocalReflex`, `orchestratorVoiceWords`, `VibyComposer.tsx`, `orchestratorRules`, and add 1-shot validation auto-repair retry in `OrchestratorDesk.think()`.
2. **Commit 3 — Speed Overhaul**:
   - Lookahead sentence pre-synthesis & cached `voiceRate` in `Speaker` (`electron/speech.ts`).
   - Add `PlannerSessionPool` (`src/core/service/planner-session.ts`) for persistent `stream-json` Claude sessions plus early `"say"` detection in `spawnBrain`.
   - Add `trimSilence` (`src/core/voice.ts`, `electron/voice.ts`) and deep-silence short-command endpointing (`src/core/call.ts`).
   - Cache `isGitRepo` (15 s TTL) & `listThemes` (30 s TTL), trim context lists, serialize copy id allocation, and parallelize independent `start` steps per wave in `OrchestratorDesk.runSteps()`.
3. **Commit 4 — Reliability, Race Fixes & Diagnostics**:
   - Inspect `detectWaitingPrompt` before settling `waitForChainedPty` and enforce bounded `chainMaxWaitMs`.
   - Await aborted `thinkingDone` wind-down on barge-in `ask()`, surface `Call.turn()` errors cleanly, and add privacy-safe `VibyDiagnostics` (`src/core/service/orchestrator-diagnostics.ts`) exposed via `inspect` `"diagnostics"`.
4. **Commit 5 — Expanded Capabilities, Memory & Reflexes**:
   - Add `recentFocusLine()` cross-turn entity anchor across the last turns in `OrchestratorDesk.think()`.
   - Add `/diagnostics`, `/trust`, `pause routine <X>`, and `switch theme to <X>` local reflexes + workbench/run UI parity (`open-folder`, `focus-next`/`focus-prev`, `check-updates`, `copy-markdown`).
5. **Commit 6 — Safe Computer Use (Wayland/Hyprland + App UI)**:
   - Add `src/shared/computer-use.ts`, `src/core/computer-use.ts`, and `electron/computer-use.ts` (`HyprlandWaylandDriver` via `hyprctl`/`grim`/`wtype`/`wlrctl`/`ydotool`/`uinput`, `X11Driver`, cross-platform `AppUiDriver`, `UnsupportedPlatformDriver`).
   - Add `"computer"` to `STEP_KINDS` (reusing existing `STEP_FIELDS` so strict schema invariants hold), `inspect` `"screen" | "windows" | "app-ui"` with multimodal screenshot hand-off into follow-up planner turns, UI/companion step cards, and 7-locale i18n strings.
   - **Strict Safety Invariants (`docs/principles.md` & Decision D1)**:
     - Every mutating `"computer"` action ALWAYS returns `holdsForGo = true` and `safeInCall = false` (waits on card for `Go`).
     - Reading screenshots/windows/DOM UI sets `checks` (`fromReading` under Decision D1) so follow-up plans steered by screen contents wait for `Go`.
     - Zero prompt/transcript logging in `vibeforge.log`; zero shell string interpolation in drivers (`execFile`/`spawn` argv arrays only).

## 4. Verification Gates

Every commit must pass:
- `npm run typecheck` (all 5 TypeScript projects including `@ts-check` JS companion files)
- `npm run lint` (Biome)
- `npm test` (including `tests/unit/i18n.test.ts` and `tests/unit/core-text.test.ts`)
- Final validation additionally runs `npm run coverage` (respecting all per-file coverage floors in `vitest.config.mts`, including 99% on `src/core/orchestrator.ts` and `src/shared/orchestrator.ts`), `npm run build`, and `npm run smoke`.
