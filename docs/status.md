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

### Credit and browser dock pass (later the same day)

- "Created by ApexForge" links to https://ame-apexforge.org/ from the Help menu's footer, the version line at the bottom of Settings, and the website's footer. In the app it opens in your browser.
- Nothing floats behind the browser dock any more. The dock is a native view drawn above the page, so floating things now deal with it in two ways (`src/ui/floating.ts`, `useLayer` in `src/ui/state.tsx`):
  - Tooltips pick another side, or slide along theirs, to stay 4px clear of it. Toasts move just left of it.
  - Menus, dialogs and the tour register the space they take. While one lands on the dock, the dock shows a still of its page (a JPEG capture) in place of the live view, then swaps back. A menu that doesn't touch the dock leaves it live; before, every menu blanked it. Menus also close when focus moves into the dock or another window.
- Checked on the built app over CDP, with a local test page in the dock:
  - tooltips on the dock's toolbar and on the pane beside it stayed clear and left the dock live
  - an error toast sat 16px left of the dock
  - the Help menu left the dock live
  - the pane's launch menu and the shortcut sheet put a still in the dock's place within 70 ms, hid the live view, and brought it back within 25 ms of closing
  - the tour never showed the dock under it, including when it came back to Code, and the dock came back afterwards
  - the credit link asked `xdg-open` for https://ame-apexforge.org/ (a stub stood in for the browser)
- `npm test`: 58 tests, now including the floating-layer geometry.

### 0.3.0: updates, languages, diagnostics (later the same day)

- **Closing the last terminal** in a workspace leaves it empty, with buttons to start a shell or a CLI. Before, it silently started a new shell in its place, so the terminal seemed not to close. The **Restart** and **Close** buttons on a pane whose program exited were covered by the terminal's canvas and ignored real clicks; the terminal now clips its canvases. Shells also start when VibeForge opens on a workspace you aren't looking at.
- **In-app updates.** Releases are versioned GitHub tags (`v0.3.0` is the first). VibeForge asks GitHub's release API for the newest one 20 seconds after start and every 6 hours (Settings → Updates turns it off; "Check now" works either way). A waiting update puts a dot on Help and an **Update to …** item at the top of its menu. The dialog shows the notes and the command, runs it in a terminal, refuses to close mid-update, and offers a restart. The command depends on the install: the installer's copy reruns `curl -fsSL https://vibe-forge.net/install | bash`; a git checkout runs `git pull --ff-only && npm install && npm run build`; anything else is told to update the way it was installed. `VIBEFORGE_UPDATE_COMMAND` and `VIBEFORGE_UPDATE_URL` override both, for packagers and tests.
- **The installer** checks out the newest release tag (`main` until one exists, or `VIBEFORGE_BRANCH` to follow a branch) and leaves `.vibeforge-installer` in its copy so the app knows to rerun it.
- **Languages:** English, Deutsch, Español, Français, Português (Brasil), 日本語 and 简体中文 (`src/ui/i18n/`), following the system language unless Settings says otherwise. The tour, rail, Help, shortcuts, tooltips, empty screens, the Code view and the new Settings cards are translated; forms and messages elsewhere are still English. Every catalog has the English catalog's type, so a missing or extra key fails the typecheck, and a test checks placeholders and markup in every language.
- **Diagnostics:** `~/.local/share/vibeforge/logs/vibeforge.log` (rotated at 1 MB) records starts, update checks, terminals starting and ending, failed calls, crashes and page errors, but never prompts, command lines or terminal output. **Help → Copy diagnostics** (also in Settings) copies the versions, a few settings and the last 200 lines; the bug report form has a field for it.
- Checked on the built app over CDP, with a stand-in release server and a stub update command:
  - closing a live shell asked first and left the workspace empty; Close on an exited shell's bar was the element under the pointer and emptied it; the empty state started a new shell
  - the automatic check found the stand-in 0.4.0; Help showed the dot, the tooltip and the accent menu item; the dialog showed notes and command, ran it in a terminal, ignored Esc while it ran, and offered Restart on exit code 0
  - all seven languages switch live, and every rail label fits; German and Japanese menus and German Settings were inspected
  - the log recorded the start, the checks, the update and each terminal
- `npm test`: 68 tests, adding translations, updates and the log.

### 0.4.0: an Omarchy look (the night of 2026-09-25)

- **The whole app, restyled after omarchy.org and the Omarchy desktop.** Square corners, JetBrains Mono for text with Geist for headings and numbers (both bundled), flat surfaces with one-pixel borders, solid accent buttons that warm to the second accent, status dots as pixels, a blinking block cursor for loading. The accent gradient stays only on the edges of floating things, as the Omarchy shell draws them; the four interaction states from Apex Forge are unchanged.
- **Pixel art from one source**, `src/shared/pixel.ts`: a 7-row pixel font for the VIBEFORGE wordmark, the V-and-spark mark, and seeded pixel fields. Shades come from the theme's accents (`--px-0` … `--px-3`), stepping the other way on light themes. `node scripts/brand.ts` regenerates the app icon, favicon, social image and the website's inline art from it.
- **Home, rebuilt**: pixel wordmark with pixels drifting in from the edge, a date-and-time line, a status sentence, square actions with their shortcuts, a stat strip in Geist (with a 14-day block chart of runs), numbered setup steps, workspaces to open in one click, and the CLIs set out like `which` output. The review stat names the newest run waiting instead of claiming "Inbox clear".
- **The website, rebuilt** to match: pixel hero with a release banner, a `which` terminal, a carousel of real screenshots (taken from a demo profile in which no CLI runs), feature triads, the theme list (press T to change theme, as on omarchy.org), install cards, and a new social image.
- **Fixed on the way:** git snapshots and review diffs no longer fill with colour codes when someone's git config says `color.ui = always` (a demo profile with that setting failed the snapshot test). The file tree shows `~` paths like the rest of the app.
- Checked: every view and the shortcut sheet under the new styles, in the built app; the Home and Code screens in a populated demo profile; the website at 1440 and 390 px and after a theme switch. `npm test`: 72 tests, adding the pixel art.

## Not verified yet

- Real runs with Codex, Grok, Cursor Agent, Gemini and OpenCode. Their seed rows use the prompt-argument and continue forms from each CLI's `--help`; Copilot, Kimi, Crush, Pi and Hermes get the prompt pasted.
- A routine firing on its own at a real cron time (the scheduler is covered by tests, not by waiting).
- Desktop notifications were sent (one reached the desktop during testing), but clicking one to open its run was not tried.
- The dock's still-for-live swap, seen on screen. The checks ran on a hidden workspace, where nothing paints, so the swap was confirmed from the page's own screenshots and the view's state, not by eye.
- **Restart VibeForge** after an update was not clicked (the relaunched window would open on the desktop in use), and what Copy diagnostics puts on the clipboard was not read back: Wayland only takes a clipboard change from a window that received real input, which a hidden test window never does.

## Known limits

- Claude Code asks you to trust each new folder once; Chat mode makes a new scratch folder per chat, so the first message of each chat waits for that answer in the terminal.
- Allowed folders are a policy in the prompt, not a sandbox.

## Cleanup

The ForgeDesk leftovers are gone: the old UI, PTY sidecar and duplicate JS modules in the repo, the old launcher, desktop entry and icons, and the old `~/.config/forgedesk`, `~/.local/share/forgedesk` and `~/.config/ForgeDesk` folders. The project now lives in its own repo, [L0nE-F0x/VibeForge](https://github.com/L0nE-F0x/VibeForge).
