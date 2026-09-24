# ForgeDesk — personal agent desk

**Working title:** ForgeDesk
**App id:** `dev.forgedesk.app`
**Who this doc is for:** Grok Build, Claude Code, or any other coding agent. Treat it as the product brief. Implement the phase you are told to implement. Do not widen it.
**Owner:** one person, on this Linux machine (Omarchy, Hyprland). No accounts, no billing, no telemetry, no multi-user.
**Inspiration:** [BridgeMind](https://www.bridgemind.ai/) as of 2026-09-25, read from the product docs at <https://docs.bridgemind.ai/docs>. Conceptual reference only. Do not copy their name, logo, marketing copy, screenshots, or layout chrome. ForgeDesk is an original personal tool that does the same job.

---

## 0. How to use this spec

Attach this file in a fresh session, or paste the prompt in [§14](#14-first-session-prompt). Build one phase, stop, and show how to run it. The next session picks up the next phase.

Disk layout the app owns:

```text
~/.config/forgedesk/          # editable source of truth (YAML, JSON, markdown)
~/.local/share/forgedesk/     # runs, transcripts, scratch chats
```

The repo is the app. User data never lives in the repo.

---

## 1. The job

Vibe coding on this machine already works. The CLIs are installed: `grok`, `claude`, `codex`, `cursor-agent`, `gemini`, `copilot`, `opencode`, and others on `PATH`. What is missing is one window that remembers **who** is doing the work, **which folder** they may touch, **when** the work should start, and **what to review** when it finishes.

ForgeDesk is that window. It launches those CLIs. It does not call model APIs itself, and it does not replace the CLIs.

One sentence: a local desktop app with three modes — Agent, Code, and Chat — that runs your existing coding CLIs over folders you approve, on routines you schedule, and leaves a reviewable result.

---

## 2. What BridgeMind actually is

BridgeMind One is a native desktop app (Mac, Windows, Linux) branded as an Agent Super App. Pro is $50/month. That fee is for the app. Claude, Codex, and Grok usage is billed by those vendors on the accounts you already have. The app detects CLIs on `PATH` and launches them. It does not bundle a model.

Work is organized three ways:

| Mode | Organized around | Use |
| --- | --- | --- |
| Agent | A persistent teammate | A role that keeps a brief, memory, skills, and approved folders across many chats |
| Code | A project folder | Terminals, files, a browser, and coding-agent sessions beside each other |
| Chat | A conversation | One-off drafting or analysis with no teammate and no project |

The website's older wording calls the third mode "Thread." The current docs call it **Chat**. A **thread** is a pane inside Code mode: a conversation scoped to the open folder. ForgeDesk uses the current docs' names.

An agent is the teammate. The CLI is only the engine. Switching from Claude Code to Grok does not create a new teammate.

Each agent has:

| Part | Role |
| --- | --- |
| Name | Identity in the roster |
| Brief | Job, standards, tone, and the actions that still need the human |
| Memory | Durable facts that should still matter next week |
| Skills | Reusable procedures: when they apply, the steps, how to verify, when to stop |
| Places | Folders the human explicitly granted |
| Chats | Separate threads with the same teammate |

Routines schedule an agent to open a **fresh chat** with a self-contained instruction. They run only while the app is open. They are not a background service and not an exact-time cron. Each run is its own chat, so yesterday's transcript does not leak into today's. Creating a task, or assigning it to an agent, does not start the agent. Execution is a separate, explicit act. Stop and resume keep the attempt.

Skills are instructions, not a secret store. Plugins (GitHub, Linear, and a long catalog) are a separate permission from "the account is connected." Read-only work can proceed; publishing, deleting, spending, and sending stay behind an approval. Dictation is a Mac push-to-talk feature. An iOS Simulator pane exists on Mac. Neither belongs in this app's first versions.

---

## 3. What ForgeDesk keeps, and what it leaves out

Keep:

- Three modes with the same organizers: teammate, folder, conversation.
- Named agents whose identity survives an engine change.
- Brief, human-editable memory, skills, and an explicit folder grant.
- Routines that open a fresh run, while the app is open, and wait for review.
- Real terminals in the project folder, plus a browser dock for localhost.
- A task list where writing the task and starting the agent are different buttons.
- Bring-your-own CLI. Usage stays on the accounts those CLIs already use.

Leave out of every phase until this spec is revised:

- Accounts, subscriptions, credits, telemetry, auto-update.
- A plugin catalog and OAuth token store.
- Voice, dictation, wake word.
- iOS Simulator, multi-agent "swarm" launchers, agent-to-agent messaging.
- Parsing a CLI's fullscreen TUI into perfect tool cards. Keep the raw terminal.
- A security sandbox. See the places rule in [§5](#5-invariants).
- macOS and Windows builds.

Personal choices that differ from BridgeMind on purpose:

- Memory is a markdown file the human edits. The app shows it and prepends it to a run. v1 does not let the agent rewrite its own memory.
- Engine launch flags live in an editable `engines.json`, not compiled into the app, because CLI flags rot.
- The window uses ordinary system decorations so Hyprland can manage it. No custom title bar that fights the compositor.
- When a run exits inside a git repo, the app snapshots `git status --short` and `git diff --stat`. That snapshot is the review, not a reconstructed tool log.

---

## 4. Stack (decided)

Do not reopen this choice in Phase 0 or 1.

| Layer | Choice |
| --- | --- |
| Shell | Electron |
| UI | React, TypeScript, Vite, Tailwind |
| Terminal | xterm.js + node-pty |
| Browser dock | Electron `WebContentsView` pointed at a URL the user sets |
| Config | YAML and markdown under `~/.config/forgedesk/` |
| Run index | SQLite at `~/.local/share/forgedesk/index.sqlite` |
| Scheduler | In-process. Tick once a minute while the app is open |
| Packaging | `npm start` from the repo is enough. No PKGBUILD in the first four phases |

Electron is the shell because node-pty is the part the product depends on, and it is the boring path on Wayland. A later port to Tauri is allowed only after the PTY, routines, and review inbox work.

Visual language: dark zinc surfaces, one amber accent, dense type, system font. No marketing pages inside the app.

---

## 5. Invariants

These are product rules. A phase that violates one is unfinished.

1. **The app never holds model credentials.** It spawns a CLI. If a CLI is not logged in, the terminal shows that CLI's own login flow.
2. **Detection, not bundling.** A launcher entry exists only when `which` finds the binary on `PATH` in a login-like environment. Ship an editable list (below). Unknown binaries can be added in Settings.
3. **Identity is not the engine.** An agent's name, brief, memory, skills, and places stay put when `engine` changes. The change applies to the next run. The UI says so before it saves.
4. **Places are a policy, not a jail.** A run's cwd must be inside one of that agent's places, or inside the chat scratch directory for Chat mode. The preamble tells the CLI to stay inside those directories. A coding CLI has a shell, so this is not an OS sandbox. Do not claim otherwise in the UI. Copy reads "Allowed folders."
5. **No secrets in brief, memory, skills, or routine prompts.** The editor shows that line above the textarea. The app does not scan for keys.
6. **Writing a task or assigning an agent does not start a process.** Only Run now, Execute, or a due routine starts one.
7. **A routine run is a new chat.** It receives the brief, memory, installed skills, and that run's prompt. It does not receive previous run transcripts.
8. **Routines fire only while the window process is alive.** On launch, missed slots are not replayed. The routine row shows the last scheduled time that was missed, if any, as "missed while closed."
9. **A routine prompt stands alone.** The editor asks for outcome, source of truth, scope, output format, and what still needs approval. The save button stays enabled either way; the hints are visible.
10. **Default routine posture is draft-for-review.** Seeded examples ask for a draft and say not to push, publish, delete, or send.
11. **Stop keeps the transcript.** Killing a run marks it `stopped`, retains the scrollback, and leaves the workspace dirty state for the human to see.
12. **Resume is a new run** linked to the same task or routine occurrence, with the previous transcript path written into the prompt. It does not animate the old PTY back to life.
13. **Mode switches do not kill PTYs.** Terminals and running turns keep going under the mode that is not on screen. A small count on the mode switch shows live processes.
14. **One accent, no BridgeMind strings** in the UI, package name, or window class.

---

## 6. Objects

### 6.1 Agent

```yaml
# ~/.config/forgedesk/agents/release-notes.yaml
id: release-notes
name: Release notes
engine: claude          # key into engines.json
brief: |
  You draft release notes from merged work in the allowed folders.
  Group changes by what a person can now do.
  Verify every claim against the repo.
  Leave the draft in the chat.
  Do not push, tag, or publish.
memoryFile: memory.md   # sibling file, created on first save
places:
  - /home/lonefox/Projects/frontier-halls
skills:
  - release-notes        # id under ~/.config/forgedesk/skills/
allowRoutines: true
createdAt: 2026-09-25T00:00:00Z
updatedAt: 2026-09-25T00:00:00Z
```

`memory.md` starts with a short comment telling the human what belongs there: preferences, decisions, constraints, lessons. Dated bullets. The human edits it in the app or in an editor.

A useful brief answers four questions, and the new-agent form shows them as placeholders:

1. What do you own?
2. What context matters?
3. What does good look like?
4. Which actions still need a person?

### 6.2 Skill

```yaml
# ~/.config/forgedesk/skills/release-notes/SKILL.md
---
name: release-notes
description: Use when turning merged commits into user-facing release notes.
---
```

Body sections, in this order: **When**, **Steps**, **Verify**, **Ask first**. A skill is installed on an agent by id. Editing the skill file changes the next run for every agent that lists it. v1 has no starter catalog. The human writes the first skill, or leaves the list empty.

### 6.3 Routine

```yaml
# ~/.config/forgedesk/routines/weekday-notes.yaml
id: weekday-notes
name: Weekday notes
agentId: release-notes
enabled: true
schedule:
  kind: cron
  expr: "0 9 * * 1-5"     # local time
prompt: |
  Look at commits merged in the allowed repo during the last weekday.
  Draft release notes grouped by outcome.
  Link each claim to a commit.
  Stop after the draft. Do not push or publish.
notify: true
```

Schedule kinds in v1: `cron` (5-field, local time) and `every` (`{ minutes: 30 }`, minimum 5). The form shows the next three fire times before save.

### 6.4 Workspace

```json
{
  "id": "frontier-halls",
  "name": "Frontier Halls",
  "path": "/home/lonefox/Projects/frontier-halls"
}
```

Stored in `~/.config/forgedesk/workspaces.json`. Layout (pane tree) is stored beside it in `layouts/<id>.json` and is allowed to be missing.

### 6.5 Task

```yaml
id: fix-lamp
title: Amber lamp reads too dim
body: |
  In frontier-halls, the hall lamp should read as one warm light, not a flat dot.
status: todo          # todo | running | review | done
agentId: release-notes
workspaceId: frontier-halls
runIds: []
```

### 6.6 Run

A run is created when a process starts. Directory:

```text
~/.local/share/forgedesk/runs/2026-09-25T090001Z_weekday-notes/
  meta.json        # id, origin, agentId, routineId, taskId, engine, cwd, prompt, startedAt, endedAt, status
  preamble.md      # exact text handed to the CLI
  scrollback.txt   # capped raw PTY capture, last 2 MB
  git.txt          # status --short and diff --stat, or "not a git repo"
```

`origin` is `agent-chat`, `routine`, `task`, `code`, or `chat`.
`status` is `running`, `exited`, `stopped`, or `failed` (failed means the process could not start).

SQLite mirrors these fields so the inbox can list them. The directory remains the artifact a person can open.

### 6.7 Chat (standalone)

No agent, no project. cwd is `~/.local/share/forgedesk/scratch/<chatId>/`, created empty. The human can attach paths by dropping them into the composer, which inserts quoted paths into the prompt. Those paths are not extra places.

---

## 7. Engines

`~/.config/forgedesk/engines.json` ships with this seed, then the human owns the file. On startup, mark each row `available` when `bin` resolves on `PATH`.

```json
{
  "engines": [
    { "id": "grok", "label": "Grok Build", "bin": "grok", "args": [] },
    { "id": "claude", "label": "Claude Code", "bin": "claude", "args": [] },
    { "id": "codex", "label": "Codex", "bin": "codex", "args": [] },
    { "id": "cursor-agent", "label": "Cursor Agent", "bin": "cursor-agent", "args": [] },
    { "id": "gemini", "label": "Gemini CLI", "bin": "gemini", "args": [] },
    { "id": "copilot", "label": "Copilot", "bin": "copilot", "args": [] },
    { "id": "opencode", "label": "OpenCode", "bin": "opencode", "args": [] }
  ]
}
```

Launch contract for an interactive run:

```text
cwd = the place, workspace, or scratch dir
env = the user's environment, untouched
argv = [bin, ...args]
then write preamble.md into the PTY as the first input only when the run has a prompt
```

Writing the preamble into the PTY is best-effort: send the text, then a newline. Do not invent `--print`, permission flags, or model flags in v1. If a CLI needs them, the human adds them to that row's `args`.

The preamble is:

```text
# ForgeDesk run
Agent: <name>
Allowed folders:
- <place>
- ...

<brief>

<memory markdown, if non-empty>

<each installed skill, file contents>

# This run
<prompt>
```

Chat mode and a bare Code terminal send no preamble unless the composer has text.

Settings includes "Recheck CLIs" which re-resolves `PATH`.

---

## 8. Screens

The window has a slim header: the word ForgeDesk, then **Agent**, **Code**, **Chat**. The active mode is filled. A live-process count sits on the right of the switch when it is non-zero. Under that, the mode's own layout. Standard window buttons come from the OS.

### 8.1 Agent

```text
┌────────────┬──────────────┬─────────────────────────────┐
│ Dashboard  │ Chats        │ Transcript / terminal       │
│ Routines   │  for the     │                             │
│ Skills     │  selected    │                             │
│ ─────────  │  agent       │                             │
│ Agents     │              ├─────────────────────────────┤
│  Release…  │              │ Composer: prompt    [Send]  │
└────────────┴──────────────┴─────────────────────────────┘
```

**Dashboard** lists agents, the next three routine fires, and runs from the last two days with status `exited` or `stopped` that the human has not opened. Opening a run clears it from that list. This is the review inbox.

**Agent page** has tabs: Chats, Brief, Memory, Skills, Places, Settings.

- New Agent asks for name, brief, engine (available ones only), and at least one place. Save is disabled until name, brief, engine, and one existing directory are present.
- Chats: a list, plus New chat. The open chat is a live terminal for that run once Send starts it. Before the first send, the pane is empty and the composer is focused.
- Send on an empty chat creates a run (`origin: agent-chat`) and launches the engine as in [§7](#7-engines).
- A later Send in that same chat writes the new text into the same PTY. It does not start a second process.
- If the process has exited, Send starts a new chat and says why ("That session ended. This is a new chat.").
- Settings holds the engine picker, the `allowRoutines` switch, and Delete. Delete asks for the agent name to be typed. It removes the YAML and memory file. It does not delete run directories.

**Routines** is a list with New, Run now, Pause, Resume, Edit, Open last, Delete. Delete removes the schedule and leaves old runs. Errors (missing agent, engine not on PATH, agent disallows routines, place missing) show on the row. Run now works even when paused, and still refuses when the agent disallows routines or the engine is missing.

**Skills** is a list of skill folders with a plain editor for `SKILL.md` and a control for which agents install it.

### 8.2 Code

```text
┌────────────┬──────────────────────────────┬────────────┐
│ Workspaces │ Pane canvas                  │ Dock       │
│            │  terminal | terminal         │ Browser    │
│            │                              │ URL ______ │
├────────────┴──────────────────────────────┴────────────┤
│ [engine ▾]  prompt…                          [Launch]  │
└────────────────────────────────────────────────────────┘
```

- Add workspace via a directory picker. Remove asks for confirmation and does not delete the folder on disk.
- Pane kinds in v1: **Terminal** and **Files**. Files is a read-only tree of the workspace plus a click-to-insert-path. Editing files stays in the user's editor. A button copies the path and a button runs `xdg-open` on the workspace.
- Split horizontal, split vertical, close pane, focus. Closing a pane kills only that pane's process group, after a confirm if a process is running.
- Launch with an empty prompt spawns the engine in the focused terminal's cwd (the workspace root for a new terminal).
- Launch with a prompt spawns a new terminal pane, creates a run (`origin: code`), and sends the preamble.
- Dropping a file onto a terminal inserts a shell-quoted absolute path at the cursor.
- The dock stores one URL per workspace, default `http://127.0.0.1:5177` only as a placeholder the human can clear. The dock can be hidden.
- Layout restores the pane tree, not the dead processes. Reopen starts with the tree empty and the workspace selected.

### 8.3 Chat

A list of past chats and New chat. New chat asks for an engine, then shows a composer. The first Send creates the scratch directory and the run. The pane is the same terminal component as everywhere else. Rename and delete live in the list. Delete removes the scratch directory and the run's scrollback after confirmation.

### 8.4 Tasks

Reachable from the Agent sidebar under Dashboard, as a second section, once Phase 4 exists. Before Phase 4 the nav item is absent, not disabled.

Columns are just the four statuses. A card shows title, agent, workspace. **Execute** is on the card. Execute requires an agent, a workspace, and that the workspace path is one of that agent's places. It creates a run (`origin: task`), sets the task to `running`, and opens the terminal. On process exit it moves the task to `review` and attaches `git.txt`. The human moves it to `done`. Stop marks the run `stopped` and the task `review`.

### 8.5 Settings

Default engine, default shell for plain terminals (`$SHELL`), notification toggle, theme stays dark, Recheck CLIs, and a text view of the resolved config directory. Notifications use `notify-send` when present and fail silently when it is not.

---

## 9. Scheduler

While the process is running, a timer fires every 30 seconds. For each enabled routine whose agent allows routines:

- Compute the most recent scheduled instant at or before now, in the local timezone.
- If that instant is newer than `lastFiredAt` and the app was already running at that instant, start a run and set `lastFiredAt`.
- If the app was not running at that instant, set `lastMissedAt` and do not start it. Surface it on the row.
- Do not overlap: if that routine's previous run is still `running`, skip and mark the row "still running."

Cron parsing: use a small maintained library. Do not hand-roll cron. Weekday and hour are local.

Run now uses the same launch path with `lastFiredAt` left unchanged, so a manual run does not swallow the next scheduled one.

On exit of a routine run, if `notify` is true, send a notification with the agent name, routine name, and status. Clicking it focuses the app on that run.

---

## 10. Processes

- Each PTY is its own process group.
- Close / Stop sends `SIGINT`, then `SIGKILL` after 2 seconds, to the group.
- Scrollback capture subscribes to PTY data, strips nothing, and caps at 2 MB by dropping the front.
- On exit, if cwd is inside a git work tree, run `git status --short` and `git diff --stat` with a 5-second timeout and write `git.txt`. Never run `git` commands that change the tree.
- The app does not watch the CLI's config directory and does not copy session files out of `~/.claude` or `~/.grok`.

---

## 11. Phases

Each phase ends with the app runnable and the acceptance checks for that phase passing. Do not start the next phase in the same session unless the human asks.

### Phase 0 — Shell

- Electron + React + TypeScript + Tailwind, app id `dev.forgedesk.app`, window class `forgedesk`.
- Header mode switch with three views. Agent and Chat can be empty states that name the phase that fills them.
- Create the config and data directories on first launch.
- README: install and `npm start` on Arch. Node is already managed by mise on this machine; do not install a second Node.

### Phase 1 — Code mode

- Workspace add and remove, persisted.
- One terminal in that cwd. Split to two panes. Close a pane.
- Detect engines from `engines.json`. Launch the selected engine into the focused pane.
- Plain shell pane uses `$SHELL`.
- Layout of which workspace was last open persists. Pane processes do not.

### Phase 2 — Agents

- Agent CRUD as YAML plus `memory.md`.
- Places picker limited to existing directories. At least one required.
- Chats list. First Send launches the engine with the preamble. Later Send writes into the same PTY.
- Inbox on the dashboard lists runs. Opening one shows the terminal if live, or scrollback plus `git.txt` if finished.
- Mode switch does not kill the PTY.

### Phase 3 — Routines

- Routine CRUD, cron and interval, next-three preview.
- In-process scheduler with the missed-while-closed and still-running rules.
- Run now, pause, resume, open last, delete schedule.
- Notification on completion.
- Seed nothing automatically. The form's placeholder text is the example.

### Phase 4 — Tasks and the browser dock

- Task board with the execute rule in [§8.4](#84-tasks).
- Browser dock with a URL field per workspace.
- Files pane: tree, insert path, `xdg-open`.

Stop after the phase you were asked for. Leave a short `STATUS.md` in the repo root describing what runs, what does not, and the check you actually performed.

---

## 12. Acceptance checks

Phase 1:

1. Add `/home/lonefox/Projects/frontier-halls`. The shell's cwd is that directory (`pwd`).
2. Split the pane. `pwd` in the second pane is the same directory. Typing in one does not affect the other.
3. Launch an engine that exists on PATH. Its UI appears in that pane. The other pane still accepts input.
4. Quit and reopen. The workspace is still in the list.

Phase 2:

5. Create an agent with one place and a brief. Send "Create a file named forgedesk-phase2.txt in this folder containing the word hello, then stop." The file exists inside the place. A run directory contains `preamble.md` and scrollback.
6. Change the engine. The brief and memory file are unchanged.
7. Switch to Code mode and back. The agent process is still running.

Phase 3:

8. Create a routine on a 5-minute interval aimed at an agent with a harmless prompt ("Append a timestamp line to /tmp/forgedesk-routine.log"). With the app open, two runs appear and the file grows. Pause. Confirm the next slot does not fire.
9. Quit before a slot. Reopen after it. The row shows missed-while-closed and the log file gains no line for that slot.

Phase 4:

10. Create a task, assign the agent and the workspace, and do not press Execute. No new process appears.
11. Execute. The task moves to `running`, then to `review` when the process exits, and `git.txt` exists when the workspace is a git repo.
12. Set the dock URL to a page the human has open locally and confirm it loads. If nothing is serving, the dock shows the load error and the rest of the app still works.

---

## 13. Out of scope

Cloud sync. Phone apps. Billing. Plugin OAuth. Voice. Simulator panes. Swarm presets. Agent-to-agent chat. Automatic memory writes. OS-level sandboxing. Catching up every missed routine. Editing source files in an in-app editor. Windows and macOS.

---

## 14. First session prompt

Copy from the line below the rule into a new session opened on `/home/lonefox/Projects/forgedesk`.

---

You are building ForgeDesk, a personal Linux app. The product brief is `FORGE-DESK-SPEC.md` in this repo. Read it before writing code.

This session is Phase 0 and Phase 1 only.

1. Scaffold Electron + React + TypeScript + Vite + Tailwind. App id `dev.forgedesk.app`. Dark zinc UI, one amber accent. System window decorations.
2. Header switches Agent, Code, and Chat. Agent and Chat are empty states.
3. Code mode: add and remove workspace folders, persist them to `~/.config/forgedesk/workspaces.json`, open a real PTY in the workspace cwd, split into two panes, close a pane, detect engines from the seeded `engines.json`, and launch the selected engine into the focused pane.
4. README with the commands to install and run on Arch.

Do not add agents, routines, tasks, or a browser dock. Do not add telemetry or an account. When Phase 1 matches the Phase 1 acceptance checks in the spec, stop and write `STATUS.md` with how to run the app and what you verified.

---

## 15. BridgeMind map

| BridgeMind | ForgeDesk |
| --- | --- |
| Agent Super App | This desktop app |
| Agent / Code / Chat | Same three modes |
| Thread pane inside a project | Phase 2 agent chat and Phase 1 terminal, both over a folder. No separate parser |
| Brief, memory, skills, places | YAML + markdown under `~/.config/forgedesk/` |
| Routines while the app is open | [§9](#9-scheduler) |
| Tasks that do not auto-run | Phase 4 |
| Docked browser, file pane | Phase 4 |
| Claude Code, Codex, Grok, others | `engines.json` |
| Pro plan and credits | Not part of the app |
| Plugins, dictation, simulator, swarm | Out of scope |

*Spec written 2026-09-25 from the BridgeMind One docs (agent, code, chat, routines, skills) and the public product description at bridgemind.ai.*
