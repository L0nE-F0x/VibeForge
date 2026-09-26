# Status — 2026-09-26

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

### The website, fused (2026-09-26)

The 0.4.0 website read as a copy of omarchy.org, so it was rebuilt again as a fusion of the first site and the pixel look (unreleased; the app is unchanged).

- **From the first site:** the waybar (workspaces 1–5 that follow the scroll, the clock in the middle, the theme menu), the bold mono headline with "forged" in the shimmering gradient, the install line and facts, the tiled desk that plays an agent run end to end, the CLI marquee, the bento of features with small animated illustrations and a spotlight under the cursor, the "hit Send" flow, the live theme preview with swatches, and the glowing install terminal.
- **From 0.4.0:** square geometry, the pixel wordmark, mark and status pixels, the desk mock redrawn as the 0.4.0 app, the real screenshots (now tabs that advance on their own), the pixel drift, and the newer copy (updates, languages, shortcuts, `vibe-forge.net/install`).
- **New:** the wordmark sits on a glowing plate that is the circuit's chip. Its traces leave the sides as parallel buses, bend at 45°, and fall down the margins beside the copy (measured from where the text really is, so the middle stays readable; on narrow screens they run off the edges). Bento cards carry pixel corner brackets that warm to the accent. The final section has embers rising off the drift. The install terminal prints its output line by line the first time it's seen. Loops pause when off screen.
- The release pill under the plate was dropped (it crowded the hero). The version is printed on the plate's bottom edge instead, like a part number on a chip, and links to the latest release. **On each release**, update it (`class="part"` in `site/index.html`) and the version in the install terminal's last lines.
- Checked in headless Chrome at 1920, 1440, 1024 and 390 px, in Apex Forge, Tokyo Night and Rosé Pine: no console errors, no horizontal overflow, the theme menu and T work, the desk demo, update sheet and language cards play.

### Voice, phase 1: dictation (2026-09-26, released in 0.5.0)

- **Dictate anywhere in the window.** Hold <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>Space</kbd> to talk, or tap it to keep listening and tap again (or click **Done**) to finish; <kbd>Esc</kbd> drops the recording. The words go to the last place that had focus: a chat's composer (focus in its terminal counts too), a Code pane's terminal, or the Code launch bar. A Code pane that has no terminal sends them to the launch bar. By default they wait there to be read (pasted into a terminal without Enter); **Settings → Voice → Send dictated words right away** presses Enter too. Composers and the launch bar have a mic button.
- Not Ctrl+Space: that is fcitx5's default input-method trigger (fcitx5 runs on Omarchy), which would swallow the key for Japanese and Chinese typists.
- **A listening bar** at the bottom: a pixel level meter, where the words will go, a timer, and the keys; it turns into a blinking cursor with "Turning speech into text" from key-up until the words land. It registers as a floating layer, so the browser dock steps aside.
- **Local only** (`electron/voice.ts`, `src/core/voice.ts`): `pw-record` (else `parec`, else `arecord`) records 16 kHz mono into memory; `whisper-server` is started on 127.0.0.1 on first use (while you are still speaking), kept for ten minutes, and stopped on quit; `whisper-cli` is the fallback, with a temporary WAV deleted at once. Silence (loudest 50 ms below −44 dBFS) and taps shorter than 0.4 s are never sent to whisper, which invents words for silence. Whisper's markers ("[BLANK_AUDIO]", "(music)") are dropped. Whisper gets a prompt sentence naming the agents, CLIs, and the workspace's top-level files. The log records lengths and timings, never words.
- **Settings → Voice**: what was found (recorder, whisper.cpp, model) with the install line when something is missing, the model (default: the best one found, including Voxtype's), the spoken language (English-only `.en` models always hear English), downloads of five ggml models from Hugging Face with progress and cancel, auto-send, and a line to try it on. `VIBEFORGE_VOICE_RECORDER`, `VIBEFORGE_WHISPER_SERVER` and `VIBEFORGE_WHISPER_CLI` override the programs, for tests and odd setups.
- The shortcut sheet has a Voice group; all new text is in the seven languages.
- Checked on the built app over CDP on the hidden workspace, with a whisper.cpp 1.9.3 build, Voxtype's `ggml-base.en.bin`, and a recorder override that plays the JFK sample in real time:
  - holding the keys in Chat showed the bar with the meter lit; the words were in the box 1.2 s after key-up (whisper-server ready 0.2 s after key-down)
  - tap to keep listening, tap again: the bar said "Turning speech into text" at once, then cleared; a second dictation appended with one space; Esc dropped a recording and left the box alone
  - a silent recording gave the "only silence" toast and no transcription; dictating with nothing focused asked where the words should go
  - in Code, the words were pasted at the shell prompt and not run; with auto-send they ran (bash: "command not found: And"); the launch bar filled
  - with whisper-server hidden, whisper-cli transcribed in 0.7 s and its temp folder was gone; with neither, the key opened Settings → Voice with the install line
  - a model download showed progress in the card and left no `.part` file when cancelled
  - quitting stopped whisper-server
- `npm test`: 85 tests, adding the voice core (recorder and whisper plans, model choice, loudness, WAV header, transcript clean-up, the prompt, settings repair).

### 0.5.0: talk to your agents (2026-09-26)

Phases 2–4 of the voice plan, on top of phase 1's dictation.

- **Talk to an agent by name.** A sentence that starts with an agent's name ("Atlas, …", "Hey Atlas: …", "tell Atlas to …", multi-word names too) goes to that agent's latest chat, or a new one, whatever has focus: left in its composer for review (the view opens on it), or sent with auto-send. Dictation now starts with nothing focused; plain words with nowhere to go are copied to the clipboard.
- **Answers read aloud** (`electron/talk.ts`, `electron/replies.ts`, `src/core/replies.ts`). After words reach an agent's terminal (sent, or pasted and later sent with Enter), VibeForge watches the CLI's own session log for the turn to end: Claude Code's `~/.claude/projects/<cwd with non-alphanumerics as ->/*.jsonl` (`stop_reason: "end_turn"`; the reply is that message's text blocks), falling back to any log whose `cwd` matches; Codex's `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` (`task_complete`). It reads only the tail of each log and prefers the session whose prompt contains the dictated words. Other CLIs say "<name> has finished" and the git change summary when they exit. Piper speaks (text on stdin, raw audio into `pw-play`, else `paplay`, else `aplay`); markdown is read as words, code blocks are skipped (or described in full mode), tables and links are dropped. Talk-back is the first paragraph by default, or all of it, or off; only answers to what you said are read.
- **Voices**: nine Piper voices to download (English ×4, German, Spanish, French, Portuguese, Chinese; Piper has no Japanese), found also in `~/.local/share/piper*` and `/usr/share/piper-voices`; the default follows the app's language; each agent can have its own (agent Settings tab, `voice:` in agent.yaml). **Barge-in**: opening the microphone stops any speech.
- **Conversation mode** (<kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>Space</kbd>, or the button on the listening bar): an end-of-speech detector (`Endpointer`: loudness against a tracked noise floor, 800 ms pause after 300 ms of speech, 20 s of nothing ends the conversation) stops each turn; the words are sent; the answer is read; the microphone opens again. The bar says "Your turn", "Hearing you", "Waiting for Atlas", or shows the answer being read.
- **Commands** after the wake word "Forge" (`src/shared/commands.ts`, a fixed grammar, English only): send, clear, stop (Esc to a CLI, Ctrl+C to a shell), continue, new task [for <agent>]: …, run [the] <routine> [routine], go to <view>, stop listening. Without a pause after "Forge" it is a command only if the rest is one ("Forge the sword" stays words). Whisper's prompt now carries command examples: with only names in it, "new task" came back as "New Desk".
- **From anywhere**: `vibeforge --voice start|stop|toggle|cancel|converse` writes to a control socket (`$XDG_RUNTIME_DIR/vibeforge-<sha1 of the data folder>.sock`, so test instances never answer for the real one; `src/core/control.ts` and `scripts/vibeforge` compute it alike) in about 10 ms, with the second-instance hook as a fallback. Settings → Voice shows Hyprland bindings (Omarchy's Lua `o.bind`, or `bind`/`bindr` for hyprland.conf): Super+Alt+V held to talk, Super+Alt+T for a conversation, and **Add to Hyprland** appends them after copying the file to `.bak.<time>`. In the background, a short tone marks start and stop and results arrive as desktop notifications.
- **Fixed on the way:** a composer replaced while whisper worked (a view re-rendering its chat) no longer loses the words; a new chat's first answer is waited for (its terminal is known before the view has the chat).
- Checked on a built copy (so the running app's `dist/` was untouched) over CDP, with a scratch HOME, a fake `claude` that writes Claude Code-format logs, a player override that captured audio to a file, the real Piper and whisper.cpp, and test sentences spoken by Piper and heard by whisper:
  - "Atlas, add tests for the scheduler." with nothing focused opened Atlas's chat with the words in the box; Send reached the CLI and the answer was read (0.6 s to transcribe)
  - "Forge, new task: fix the login page." added the task; "Forge, go to tasks." opened Tasks
  - a conversation on a new chat: paused speech sent itself, "Waiting for Atlas", the answer read, the microphone reopened, Esc ended it
  - `scripts/vibeforge --voice start|stop` took 9–15 ms; "Atlas, …" then "Forge, send" from the socket sent the waiting words and the answer was read
  - the launch bar with auto-send started Claude Code with the words and read its answer; review mode in a Claude pane pasted without sending, and Enter brought the answer
  - speaking stopped 8 ms after the microphone opened; an engine without a log said "Plain · place has finished. 1 file changed, …"; Add to Hyprland wrote the bindings to the scratch HOME's hyprland.conf
  - quitting left no whisper-server, Piper or CLI behind, and removed the socket
- The website has a voice card and an answer card in the bento, and says 0.5.0 on the plate and in the install terminal. Checked at 1440 and 390 px: no overflow, no console errors.
- `npm test`: 106 tests, adding the end-of-speech detector, Piper planning, both session-log readers, speech text, the command grammar (with what whisper really wrote), the control socket and bindings, and agent voices.

### Polish pass (2026-09-26, after 0.5.0)

A pass over the UI for daily use, plus three bugs from the audit.

- **Code** lost the four engine buttons in its top bar and in empty panes; people type `claude` or `codex` in a terminal. The toolbar is now: give a CLI a job, new terminal right, new terminal below, and one toggle for the Files/Browser panel. The launch bar is hidden until <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>L</kbd>, the rocket button, or dictated words with no terminal to land in open it; <kbd>Esc</kbd> closes it.
- **Pane title bars** have two buttons, ⋯ and ✕, which show on the focused pane and on hover. The ⋯ menu holds split right/down, maximize and "Run … here". New shortcuts: <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>D</kbd>/<kbd>E</kbd> new terminal right/below, <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>W</kbd> close the focused one.
- **Terminals name what they run.** The PTY host polls each terminal's foreground process group once a second (`/proc/<pid>/stat` tpgid and `/proc/<tpgid>/cmdline`, Linux only), and `programOf` (src/core/engines.ts) names it: an engine's label when the binary matches (seeing through `node …/codex.js`, `npx`/`npm exec`, npm's rewritten process title, and Claude's `~/.local/share/claude/versions/2.1.283` launcher), else the program's own name (`tsc`, `vim`, `npm run dev`). Pane titles, Home's Live now and the rail's live list use it; shells are named after their workspace instead of `bash`.
- **Voice with CLIs typed into a shell.** "Stop" sends Esc (not Ctrl+C) to a detected CLI, and talk-back reads the answer from the CLI's session log in the folder that CLI runs in. Before, talk-back only worked for CLIs VibeForge had launched.
- **Workspaces** drag to reorder (saved through `workspaces.move`), rename with a double-click or F2, have a right-click menu, and <kbd>Alt</kbd>+<kbd>1</kbd>…<kbd>9</kbd> jumps to one from anywhere.
- **The rail** can hide views (right-click one) and reorder them (**Settings → Rail**, saved as `rail` in settings.json); <kbd>Ctrl</kbd>+number follows the visible order, and Home's key hints follow it too. Code can't be hidden.
- **Home** dropped the four stat tiles that repeated the headline and the lists; the 14-day chart is one strip.
- Smaller things: the Runs filter sat against the top edge of its header (`.segmented` had `align-self: flex-start`); the Agents header no longer repeats **New chat** on the Chats tab; the Routines header hides its **New routine** while the empty state shows one; a few English leftovers are translated; the tour's "Hand a CLI a job" step points at the rocket button.
- **Audit fixes** (docs/audit.md, items 1–3): a routine that can't start (folder or CLI gone) records a failed run and logs why instead of passing its slot silently; a crashed task is sent to Review only while the orphan is still its latest run, and Execute, Continue and Code launches wait for crash cleanup; Copilot, Crush, Pi and Hermes seeds gained continue flags (Copilot and Pi prompt flags too), and exact resume also reads `--resume=<id>` and `--session <id>`. Existing `engines.json` files are not rewritten; delete yours to pick up the new seeds.
- Checked on the built app over CDP on a hidden workspace: the shortcuts, the launch bar opening and closing, a drag reorder, Alt+3, hiding Tasks from the rail and its Settings card, pane titles for a fake CLI, `vitest`, and `tsc`, and every view with demo data. The website's three screenshots were retaken from a demo profile.
- `npm test`: 109 tests, now including `programOf`, the new resume shapes, a routine whose folder vanished, and the orphan-task rule.

## Not verified yet

- **Voice with a real microphone, real speakers, and real Claude Code**: the checks drove keys over CDP (which bypasses fcitx5), played files instead of the mic, captured speech to a file, and used a stand-in CLI writing Claude Code's log format (taken from a real session log). Codex's reader follows the rollout format but no Codex session has been read yet. The end-of-speech thresholds are tuned on Piper's voice, not a room. Screenshots failed on the hidden workspace, so the bars and the Voice card were checked through the DOM, not by eye.
- **The Hyprland bindings on the real desktop**: Add to Hyprland was tried against a scratch HOME only.

- Real runs with Codex, Grok, Cursor Agent, Gemini, OpenCode, Copilot, Crush, Pi and Hermes. Their seed rows use the prompt-argument and continue forms from each CLI's `--help`; Kimi, Crush and Hermes get the first prompt pasted.
- Program detection and talk-back with the real `claude`, `codex` and `grok` typed into a shell (checked with stand-ins and the process table, not a live session).
- A routine firing on its own at a real cron time (the scheduler is covered by tests, not by waiting).
- Desktop notifications were sent (one reached the desktop during testing), but clicking one to open its run was not tried.
- The dock's still-for-live swap, seen on screen. The checks ran on a hidden workspace, where nothing paints, so the swap was confirmed from the page's own screenshots and the view's state, not by eye.
- **Restart VibeForge** after an update was not clicked (the relaunched window would open on the desktop in use), and what Copy diagnostics puts on the clipboard was not read back: Wayland only takes a clipboard change from a window that received real input, which a hidden test window never does.

## Known limits

- Claude Code asks you to trust each new folder once; Chat mode makes a new scratch folder per chat, so the first message of each chat waits for that answer in the terminal.
- Allowed folders are a policy in the prompt, not a sandbox.

## Cleanup

The ForgeDesk leftovers are gone: the old UI, PTY sidecar and duplicate JS modules in the repo, the old launcher, desktop entry and icons, and the old `~/.config/forgedesk`, `~/.local/share/forgedesk` and `~/.config/ForgeDesk` folders. The project now lives in its own repo, [L0nE-F0x/VibeForge](https://github.com/L0nE-F0x/VibeForge).
