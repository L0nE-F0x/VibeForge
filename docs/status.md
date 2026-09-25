# Status — 2026-09-25

VibeForge (formerly ForgeDesk) was rebuilt on top of Grok's first pass: new name, new UI, and a rewritten core. It runs from `npm start` (dev) and from the `vibeforge` launcher / app-menu entry (after `npm run build`).

## Verified

- `npm test`: 41 tests at the time. Core rules (places, preamble, engines and prompt delivery, schedules, tasks, theme parsing, git snapshots, the run index), the service end to end against a fake PTY host (chat start/paste/continue, exact resume, routines firing / missed / no overlap / run-now, the task lifecycle, orphaned runs after a crash, shutdown, change events), and the real PTY host with `/bin/bash` (cwd isolation, timed bracketed paste, killing a process group, run files).
- `npm run typecheck` and `npm run build` are clean.
- The built app was driven over the DevTools protocol on a hidden Hyprland workspace with a scratch config: every view renders; Code mode restores its split layout and shells after a restart; agent chat, task execute → review with a git summary and full diff, routine editor preview, browser dock (load and error card), settings, and quitting with live runs (recorded as stopped, files written).
- **Real Claude Code**: a Chat message arrived intact as the first prompt (`VIBEFORGE-OK`), a follow-up pasted from the composer was submitted (`SECOND-OK`), and **Continue** reopened the same conversation with `claude --resume <id>` read from the transcript.
- Window class is `vibeforge` under Hyprland; `~/.local/share/applications/vibeforge.desktop` validates.

### Layout and onboarding pass (later the same day)

- Side panels in Agents, Code, Chat, Skills and Runs resize from their edge (double-click resets) and collapse to a strip of avatars or initials with <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>B</kbd>; each remembers its width.
- Code panes move by dragging their title bar onto another pane (the middle swaps, an edge docks) and maximize with a double-click or <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>M</kbd>. A moved shell kept its session (checked over CDP).
- One tooltip layer for the whole app, with keycaps for shortcuts; every icon-only button has a tip.
- A welcome tour opens on first launch (`tourDone` in settings.json), spotlights each view in turn, and can be replayed from Help in the rail or from Settings. Help also has the shortcut sheet and opens GitHub issue forms (`.github/ISSUE_TEMPLATE`) with the version, OS and installed CLIs filled in.
- `npm test`: 47 tests, now including the pane tree (`src/ui/pane-layout.ts`) and the tour flag.

## Not verified yet

- Real runs with Codex, Grok, Cursor Agent, Gemini and OpenCode. Their seed rows use the prompt-argument and continue forms from each CLI's `--help`; Copilot, Kimi, Crush, Pi and Hermes get the prompt pasted.
- A routine firing on its own at a real cron time (the scheduler is covered by tests, not by waiting).
- Desktop notifications were sent (one reached the desktop during testing), but clicking one to open its run was not tried.

## Known limits

- Claude Code asks you to trust each new folder once; Chat mode makes a new scratch folder per chat, so the first message of each chat waits for that answer in the terminal.
- Allowed folders are a policy in the prompt, not a sandbox.

## Cleanup

The ForgeDesk leftovers are gone: the old UI, PTY sidecar and duplicate JS modules in the repo, the old launcher, desktop entry and icons, and the old `~/.config/forgedesk`, `~/.local/share/forgedesk` and `~/.config/ForgeDesk` folders. The project now lives in its own repo, [L0nE-F0x/VibeForge](https://github.com/L0nE-F0x/VibeForge).
