# Changelog

All notable changes to VibeForge are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/): a version, a date, and an [Unreleased] section for what is on `main` but not tagged yet. Versioning rules are in [CONTRIBUTING.md](CONTRIBUTING.md). The notes for each tagged version are the ones published on its [GitHub Release](https://github.com/L0nE-F0x/VibeForge/releases).

## [Unreleased]

## [2.1.0] - 2026-10-04

**2.1: your desk on your phone, plan limits for whoever is signed in, and another branch beside the folder you have.**

**A phone page: check your workspaces and tell a CLI what to do next, from your phone.**

- **Settings → Phone** serves a small page, off until you turn it on and listening on this computer only (`127.0.0.1:4737`). Pair it once with the code in Settings; reach it from your phone through Tailscale Serve (the README has the one command).
- **See what's happening.** Each workspace with the coding CLIs working, waiting or recently finished in it, the plan limits the desktop shows, and a CLI's screen, which opens at its end and follows new output.
- **Start and steer.** Start an agent allowed in a workspace, or any installed CLI on its own, with an optional first prompt. Send the next prompt, pick a finished run back up with your next instruction (a task resumes in its own copy, as its agent), and stop it. A CLI typed into a terminal is interrupted instead, so the terminal stays, and a message never lands in a terminal whose CLI has quit.
- **Buzzes** while the page is open, when a CLI starts waiting or finishes. A buzz on a locked phone is still to come.
- **In your language.** The page speaks the language VibeForge does, errors included.
- **The same look as the desk.** Square corners, JetBrains Mono with Geist headings, flat panels, the pixel plan marks, a slow ember while a CLI is working, and an amber glow when one is waiting. Plan limits start closed; Show in that panel opens them.
- **Installs onto the phone.** The first visit on a phone offers to install the page. Installed from that offer, it fills the screen.
- **The keyboard.** Tapping a text box shrinks the page to the space above the phone's keyboard. The box and its button stay on screen, and the terminal gives up the room.
- **A follow-up as a CLI leaves a shell.** Send looks at the terminal at that moment, so the second after a CLI quits is not typed into the shell. If the run is still closing, the follow-up waits and then resumes the session. A wrong pairing code during Send, Stop or Start brings the code form back.

**The usage meter follows the plans this computer is signed in to.**

- **Whoever is signed in.** Claude, Codex, Grok, Kimi and Muse each appear when that CLI's own sign-in is on this machine, and stay off the list when it isn't. Signing in to another one shows it on the next refresh, in the desktop usage tab and on the phone page.
- **Muse.** Its 5-hour and weekly windows come from the sign-in check Meta already uses. The extra key in that answer is thrown away and never saved. Token totals come from Muse's own session logs, on this machine.
- **Codex from the sign-in too.** Its bar still comes from its logs, and also from the usage Codex itself asks for when `~/.codex/auth.json` holds a ChatGPT login. An API-key login adds no plan.
- **The newer reading wins.** Between refreshes, Codex and Muse keep whichever is newer: the last answer from the provider, or the line in that CLI's own log. The time on the bar is when that reading was taken.
- **Muse in Settings → Engines.** An engines list saved before Muse existed gains a Muse row, once. Removing that row keeps it removed.
- **Muse in Runs.** Typing `muse` in a workspace is recorded and labeled Muse, on the desk and on the phone, including when its launcher has swapped in `muse-bin-<version>`. The Prompts tab reads what you typed from Muse's own session log.

**Open another branch without moving the folder you already have.**

- **Its own workspace.** In Code, a workspace's menu has **Open another branch**. This folder stays on its branch. The branch you pick is checked out beside the project and added as its own workspace, named with the repository and the branch. A branch that is already checked out opens that folder instead of making a second copy. Removing the workspace later leaves the folder on disk.

**A git checkout opens the code on this computer.**

- **`vibeforge` builds when the checkout is newer.** Opening the app from a clone builds first when that code is newer than the last build, then opens the window. Quit and open it again to load code that changed while the window was open. The installed copy still updates through the installer.

**A tiled window can pan.**

- When other windows share the workspace, VibeForge shrinks to the tile instead of leaving the right side off the screen. Code, Chat, Agents, Runs and Skills stay wide enough to read, and a bar along the bottom of the window slides across whatever the tile cuts off. The list column gives a little of its width back while the tile is narrow. The side browser is cut to the part of the page still on screen, so panning it does not draw over the bar on the left.

## [2.0.0] - 2026-10-01

**2.0: agents take turns in a folder, and everyone waiting for you has a name.**

- **Agents take turns.** A task you Execute in its workspace, a routine you Run now, and a routine that comes due now wait while another coding CLI is busy in the same folder (or a folder inside it, in the same repository), and start on their own once it has been quiet for half a minute. An agent that's just sitting idle doesn't hold anything up, and your own Code terminals and chats never wait. The task sheet says who it's waiting for, with **Start now in a copy**, **Start now anyway** and **Stop waiting**. Home has a **Waiting their turn** list.
- **Every waiter has a name.** Home's new **Waiting for you** list shows each CLI that went quiet out of sight, by agent or CLI and where it is, and opens right there: the pane in Code, the chat, the task or the run. The tray menu lists them too, and one notification covers everyone who started waiting at once.
- **Each terminal glows on its own.** Looking at one pane no longer clears the others in the same workspace; the workspace keeps its glow until every terminal in it has been seen.
- **A CLI asking something when it starts counts as waiting.** Claude Code asking to trust a folder, or a CLI asking you to sign in, sat there unnoticed before. After 12 seconds on that first screen it glows like any other waiter.
- **Who else is in this folder.** Code panes, chats, Home's live list, the task sheet and the routine list name the other coding CLIs working in the same folder.
- **Hand off.** On a finished run, **Hand off** makes a To do task for another agent, with the run's notes: what changed, how it ended, and where the full transcript and diff are. Nothing starts until you Execute it.
- **Separate copies, said plainly.** The hint now says a copy has your committed files only (no `node_modules`), isn't a sandbox, and shares the workspace's ports. Copies of one repository are made, applied and removed one at a time.

**Why 2.0.** Execute and routines used to start whenever the agent, folder and engine were fine. Now they can wait. Existing tasks and routines are unchanged and still start at once when nobody else is busy in their folder. To keep the old always-start behaviour for one of them, turn off **Take turns with other agents in this folder** in its form, or set `shareCheckout: true` in its file. Waiting happens while VibeForge is running, including in the tray. If you quit, a routine slot that was waiting counts as missed, as before, and a waiting task stays in To do. Nothing in your config is rewritten, and 1.3 still reads it (it ignores the new field).

## [1.3.1] - 2026-10-01

**1.3.1: a task's copy can't take your real folder with it.**

- **Discard, Apply and delete only touch a task's own copy.** A task file points at its copy by path, and that file is plain YAML you, or an agent, can edit. If that path named some other folder, such as the project itself, Discard or deleting the task could remove it. Now VibeForge only stages or removes a copy that sits in its own `worktrees/<task>` folder. Anything else is left exactly as it is, and the task sheet says so, with a button to forget the record.
- **The conflict message says what Discard won't do.** When Apply leaves conflict markers, discarding the copy afterwards doesn't take them out of the workspace, and the message now says so.

## [1.3.0] - 2026-09-30

**1.3: talk from your chair, let agents work in their own copy, and find any run by what it said.**

- **Dictate without holding anything.** The mic now works as a click: click it, talk for as long as you like, click it again. Holding it and letting go still works, and so does holding Ctrl+Shift+Space. Code has a mic of its own in its toolbar, which types into the terminal that has focus and hands the keyboard back to it, so Enter sends.
- **A task can work in its own copy.** Turn on **Work in a separate copy** and Execute makes a git worktree of the workspace on a `vibeforge/<task>` branch. The agent works there, so it never edits the folder you, or another agent, are in. **Apply** brings the changes into the workspace as uncommitted edits (with conflict markers if the workspace changed the same lines meanwhile) and removes the copy; **Discard copy** throws it away.
- **Find a run by what it said.** Search in Runs, and Ctrl+K, look through every run's transcript as well as its title, prompt and folder, and show the words around the match.
- **Runs take a tenth of the room.** A finished run's terminal capture and saved diff are kept gzipped, which makes them about ten times smaller; they open as before. **Settings → Storage** shows where the space goes, and can remove runs older than 30 days, 90 days or a year, or the oldest beyond a size you pick. It keeps everything by default, and never removes a run waiting for review or the latest run of a chat or task.
- **Plan alerts.** Settings can notify you when a plan window passes 80%, 95% and 100%, once per step until it resets. Off by default.
- **Everything in your language.** Agents, Tasks, Routines, Skills, run details, Settings, toasts and the errors VibeForge reports are now translated, and times like "5 min ago" follow your language. Only the language you use is loaded, so the app starts with a smaller bundle than 1.2 despite the extra text.
- **Better with the keyboard.** Everything reached with Tab shows an ember focus ring, dialogs keep Tab inside them and give focus back when they close, and they have names for screen readers.
- **A quieter log.** A harmless browser notice that filled a third of `vibeforge.log` is no longer written, and bursts of the same error are folded into one line with a count.
- **A run that just ended says "just now"**, not "in a moment".
- **Installing with Node 22 works.** The build used to fail there (Node 22 doesn't list `node:sqlite` as a built-in, so the build tried to bundle it); it only worked on newer Node.

## [1.2.0] - 2026-09-30

**1.2: it glows when it needs you, and stays out of the way when it doesn't.**

- **What needs you glows like an ember.** A workspace or chat waiting for you is lit, not ringed: a bright core with a soft bloom around it, which flares once when it starts waiting and then breathes. Its row warms from a glowing left edge, and the view's own icon in the rail lights up too. A CLI at work is a slower ember, and a finished one glows green for a moment before it settles. With reduced motion on, the glow stays and the movement goes.
- **Runs read by project, a day at a time.** The Runs list has a heading for each day (Today, Yesterday, then the weekday and the date), and a Code run leads with its project, with the CLI on the line under it.
- **A quieter run header.** Continue or Stop, and Open in workspace, stay in view. Opening the folder and marking a run reviewed moved into the … menu.
- **Things move instead of jumping.** The rail's marker slides to the view you open, a list's highlight slides to the row you pick, and views fade in. ↑/↓ now also move through the Runs list.
- **The terminals you're not typing in step back.** In a split, the other panes dim a little; hovering one brings it forward.
- **Loading looks like what's coming.** Lists and a run's page show placeholder rows while they load, instead of a spinner or an early "No runs yet". A quick load shows nothing at all.
- **Undo instead of "are you sure?".** Deleting a chat, task, skill or routine happens at once, with Undo on the toast (or Ctrl+Z) for a few seconds. Only a chat or task that is still running asks first, since stopping it can't be undone.

## [1.1.0] - 2026-09-29

**What a run changed stays with it, and a link in Code opens beside the terminal.**

- **A run keeps the diff from the moment it ended.** When a CLI exits, a pane is closed, or the process is killed mid-task, the run saves the full patch: tracked changes since it began, and the text of new files. Changes shows that saved patch, so later edits in the folder stay separate. A new file over 256 KB, or a binary one, is named and left in the working tree. If VibeForge itself is killed before it can save, it writes the patch the next time it opens.
- **A link in a Code terminal opens the side browser.** Click an http or https address, including a local dev server, and that workspace's browser opens on it. Each workspace keeps its own page: switch projects and you get that project's page (or the empty card), and switching back leaves you where you were. The arrow on the address bar opens the page in your own browser, and so do links in Help, Settings, Home and the update dialog.
- **Open in workspace takes a run to its own workspace.** After Continue on a Code run from Runs, Open in workspace put the CLI in whichever workspace Code last showed, and stayed there. It now switches to the run's workspace first.
- **A CLI started with a prompt glows when its first turn is done.** `claude "fix the tests"` typed in a Code terminal starts working at once, and its workspace never glowed, knocked or notified for that first turn. Later turns did.

## [1.0.0] - 2026-09-28

**1.0: checked end to end, on a supported Electron.**

Nothing to relearn. Every line was read and every view gone through before this release, and what turned up is fixed below. From 1.0 on, versions follow semantic versioning: a change that breaks how you use VibeForge gets a new major version.

- **Electron 44, with Chromium 152.** VibeForge ran on Electron 37, which stopped getting security fixes in November 2025, so the browser dock showed web pages in a year-old Chromium. Updating downloads the new Electron once (about 120 MB).
- **Folder pickers open beside your projects**: next to the folder you picked last, or your newest workspace, instead of Downloads.
- **Closing the window quits when your bar has no tray.** Closing to the tray on a bar without one hid VibeForge with no icon to bring it back. It now checks that something shows tray icons (Omarchy's bar does), and a start at login waits a few seconds for the bar before showing the window instead.
- **Web pages in the browser dock can't use your microphone.** Electron gives a page every permission it asks for unless the app says otherwise, so a page open in the dock could turn on the microphone, send notifications or read the clipboard without asking. Pages now get only what a browser allows without asking: copying to the clipboard.
- **Quitting works when the terminal host is down.** If the terminal host had failed to start, or had stopped for good, quitting closed the window but left VibeForge running without one, and opening it again did nothing until that process was killed.
- **A terminal host that won't start says so once.** It was restarted every second, forever, with two error messages each time. Now a failed start shows one message, even when it happens as VibeForge opens, and a host that keeps crashing is brought back three times in five minutes, then left off with a note to restart VibeForge.
- **A settings.json you're editing by hand is left alone.** One that didn't parse, say mid-edit, was replaced with the defaults the next time VibeForge read it.
- **Release notes in the update dialog are formatted**, with lists and bold, instead of showing raw Markdown.
- **The tour shows every step.** "Every session is kept" was skipped when no terminal was open, which is every first run, so the count jumped from 4 to 6; its bold word also showed as `**run**`.
- **The Sounds toggles no longer black out the window.** Clicking one scrolled the whole app off screen, because each toggle's hidden checkbox sat outside the Settings scroll area. Every toggle now keeps its checkbox with it.

## [0.8.0] - 2026-09-28

**A desk that keeps your place.**

- **Views remember where you were**, even after a restart. Switch from Agents to Code and back (the rail or Ctrl+1…9) and you land on the same agent, tab and chat, with the lists scrolled where you left them. The same goes for Chat, Tasks, Routines, Skills and Runs.
- **Go to anything with Ctrl+K.** Type part of a name to jump to an agent, chat, workspace, task, routine, skill, view or a Settings section. From inside a terminal it's Ctrl+Shift+K, since Ctrl+K belongs to the program there. The logo at the top of the rail opens it too.
- **Sounds.** Short tones made on your machine: two soft knocks when a CLI or agent is waiting for you, a chime when a task, routine or typed CLI finishes, a lower tone when one fails, and a chirp when dictation starts, stops or is dropped. By default only while VibeForge is in the background, and never during Omarchy's Do Not Disturb (voice aside). Settings → Sounds turns each one off, sets the volume and plays them.
- **Agents tell you when they answer.** An agent chat that goes quiet while you're elsewhere now glows in Agents (the agent and the chat), puts a dot on the rail, and sends a notification that opens that chat. Before, only Code's workspaces did this.
- **Nothing you typed gets lost.** A half-written chat message, and unsaved edits to a brief, memory, agent settings, task, skill or routine, are kept when you switch views, close the sheet or quit, until you send, save or press Discard. Cancel in the routine editor still throws the edit away.
- **VibeForge in the tray.** An icon in Omarchy's bar with the other tray apps (pin it to the bar from the tray's arrow). Click to open the window; right-click for sounds, notifications, start at login, Settings and Quit. The icon gets an amber corner while something is waiting for you. Closing the window keeps VibeForge running there, so terminals and routines carry on. **Start at login, in the tray** (off by default) adds an autostart entry that opens VibeForge with its window tucked away. All three are in Settings → Tray and startup.
- **Back and forward.** Alt+→ goes forward again after Alt+←, and the mouse's side buttons do both, even over a terminal.
- **Arrow keys in lists.** With an agent, chat, skill, run or workspace focused, ↑/↓ open the one above or below; Home and End jump to the ends.
- **Voice is one gesture: hold to talk.** Hold Ctrl+Shift+Space, or the mic, and let go. The words go into the box or terminal that has focus and wait for Enter. Super+Alt+V talks to one agent, the one picked in Settings → Voice or the last you dictated to. After you send a dictated message, the first paragraph of the answer is read aloud. Tap-to-toggle, conversation mode (Ctrl+Alt+Space), the "Forge," commands, routing by an agent's name and auto-send are gone.
- **Finished runs keep their last screen.** A full-screen CLI that cleared the terminal on exit used to leave a blank run; the last frame with text is kept now, and older blank runs are rebuilt from their scrollback when opened.
- **Grok runs show what you typed.** A `grok` started in a terminal lists the prompts you gave it in the run's Prompt tab, read from Grok's own session log.

## [0.7.0] - 2026-09-26

**Plan limits.**

- **See how much of each plan you've used.** Click the pulse at the bottom of the rail: the new **Limits** tab shows Claude's 5-hour and 7-day windows, Grok's credits by product, Kimi's weekly and 5-hour windows, and Codex's limits. Each plan shows when it resets, the last day as a line, and when you'll run out at your current pace. The plan closest to its limit is marked **Hot**.
- **The rail follows your hottest plan.** The six squares under the pulse fill with it, turn amber past 80% and red when a plan is full, and the tooltip names it.
- **Off until you turn it on.** Settings → Usage and activity → **Show plan limits**. VibeForge then asks Anthropic, xAI and Moonshot at most every 3 minutes, with the sign-in each CLI already saved on your machine. It only reads those sign-ins: it never renews, rewrites or keeps them. When one has expired, the last numbers stay up until you next open that CLI. Only percentages are saved.
- Codex's limits come from its own logs, so they show without the switch. Token counts per CLI moved to the **Tokens** tab.

## [0.6.0] - 2026-09-26

**One way in, and a desk that notices.**

- **Type a CLI, get a run.** Type `claude`, `codex`, `grok` or any coding CLI in a Code terminal and VibeForge records the session as a run, from the moment it starts until you're back at the prompt: transcript, final screen and the git diff. The **run** link on the pane opens it, and sessions that changed files wait in **Needs review**. The rocket button, the launch bar (`Ctrl+Shift+L`) and the pane's "Run … here" menu are gone.
- **See who needs you.** When a CLI goes quiet or finishes in a workspace you aren't looking at, that workspace glows amber and the Code button in the rail gets a dot. With VibeForge in the background, a notification takes you there.
- **Workspace status at a glance.** One pixel per workspace: open, working, waiting for you, or finished.
- **Token usage.** Under the live pulse in the rail, today's tokens; click it for each CLI's usage today and this week, read from the logs Claude Code, Codex, Grok Build and Gemini CLI keep on your machine. Nothing is sent anywhere.
- **A year of commits on Home**, from git in your workspaces, drawn in your theme's colours. Pick **GitHub** in Settings → Usage and activity to show your GitHub contribution graph through the `gh` CLI you're signed in to (off by default; VibeForge keeps no token).
- **Copy and paste in terminals.** Ctrl+C copies the selection (and interrupts when nothing is selected), Ctrl+V pastes, and Omarchy's Super+C / Super+V work too. An image on its own still pastes into Claude Code.
- A quieter Home: empty sections hide, and your CLIs are a row of chips.

## [0.5.1] - 2026-09-26

A polish pass for daily use: a quieter Code view, terminals that say what they're running, and a rail you can shape.

### Code

- The engine buttons are gone from the top bar and empty panes. Type `claude`, `codex` or any CLI in a terminal, as you would anyway.
- The launch bar is hidden until you want it: <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>L</kbd> or the rocket button opens it, <kbd>Esc</kbd> closes it. Dictated words with no terminal to land in open it too.
- Each pane shows just two buttons, ⋯ and ✕. The menu holds split, maximize and "Run … here".
- New shortcuts: <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>D</kbd> / <kbd>E</kbd> for a new terminal right or below, <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>W</kbd> to close one.
- Terminals are named for what runs in them: `claude` typed at a prompt reads "Claude Code" in its title bar, on Home and in the live list. Shells are named after their workspace.
- Workspaces drag to reorder, rename with a double-click, have a right-click menu, and <kbd>Alt</kbd>+<kbd>1</kbd>…<kbd>9</kbd> jumps to one from anywhere.

### Voice

- A CLI typed into a shell now answers out loud like one VibeForge launched, and "stop" interrupts it with Esc instead of Ctrl+C.

### Everywhere

- Right-click a view in the rail to hide it. **Settings → Rail** brings it back and sets the order; <kbd>Ctrl</kbd>+number follows it.
- Home is simpler: the stat tiles that repeated the headline are gone.
- Smaller fixes to headers, duplicate buttons and untranslated text.

### Fixes

- A routine that can't start (its folder or CLI is gone) now leaves a failed run saying why, instead of skipping silently.
- After a crash, a task you run again straight away is no longer knocked back to Review.
- Continue now reopens the last session for Copilot, Crush, Pi and Hermes. Existing `engines.json` files are left alone; delete yours to pick up the new defaults.

**Update:** use Help → Update to 0.5.1, or rerun `curl -fsSL https://vibe-forge.net/install | bash`.

## [0.5.0] - 2026-09-26

Talk to your agents, and hear them answer. Everything runs on your machine: whisper.cpp turns speech into text, Piper reads answers aloud, and no audio leaves your computer or is kept.

### Set up

- Install whisper.cpp with `sudo pacman -S whisper-cpp`, and Piper with `uv tool install piper-tts` (or the AUR's `piper-tts-bin`).
- **Settings → Voice** shows what VibeForge found. It downloads speech models and voices from Hugging Face and gives you a line to try dictation on. Models that Omarchy's Voxtype already downloaded are found too.

### Dictate

- Hold <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>Space</kbd> and speak, then let go. Or tap it to keep listening and tap again to finish. Every message box also has a mic button.
- The words land where you last clicked: a chat, a terminal in Code, or the launch bar. They wait there for you to read and press Enter. Settings can send them straight away instead.
- Whisper is told the names of your agents, routines, CLIs and workspace files, so it spells them right.

### Talk to agents

- Start with a name: "Atlas, add tests for the scheduler." goes to Atlas's latest chat, whatever has focus.
- When you've spoken to an agent, its answer is read back to you: the first paragraph (the default), all of it, or nothing. Each agent can have its own voice. Start talking to cut the answer short.
- Claude Code and Codex answers are read from their own session logs. Other CLIs say when they finish and what changed.
- <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>Space</kbd> starts a hands-free conversation. Pause and it sends; the answer is read; then it listens again.
- Commands start with "Forge": "Forge, send", "Forge, new task: fix the login page", "Forge, run the nightly routine", "Forge, go to tasks", "Forge, stop listening".

### From anywhere on the desktop

- `vibeforge --voice start|stop|toggle|cancel|converse` reaches the open window in a few milliseconds.
- **Settings → Voice → Add to Hyprland** binds hold <kbd>Super</kbd>+<kbd>Alt</kbd>+<kbd>V</kbd> to talk and <kbd>Super</kbd>+<kbd>Alt</kbd>+<kbd>T</kbd> for a conversation. It backs up your bindings file first.
- While VibeForge is in the background, a short tone marks the start and the end, and results arrive as notifications.

All the new text is in the seven languages.

**Update:** use Help → Update to 0.5.0, or rerun `curl -fsSL https://vibe-forge.net/install | bash`.

## [0.4.0] - 2026-09-25

An Omarchy look for VibeForge and its website.

### The look

- The app is restyled after omarchy.org and the Omarchy desktop. It has square corners, JetBrains Mono for text and Geist for headings (both come with the app), and flat panels with one-pixel borders.
- Buttons are solid accent colour, status dots are pixels, and loading shows a blinking block cursor.
- The accent gradient is only on the edges of menus and dialogs. Hover, press and focus look the same as before.
- A new pixel-art mark (a V with a spark) is now the app icon and the logo in the rail. The pixel art takes its colours from your theme.

### A new Home

- The Home screen shows the pixel wordmark, the date and time, and one sentence on what is running and what waits for review. Buttons with their shortcuts open a workspace, start an agent or start a quick chat.
- A row of stats shows what is live, what waits for review, runs over the last 14 days as a block chart, and your routines.
- New installs see three numbered setup steps.
- Your workspaces open in one click, and the coding CLIs VibeForge found are listed like `which` output.
- Home is translated into all seven languages.

### Fixes

- If your git config sets `color.ui = always`, run snapshots and review diffs no longer fill up with colour codes.
- The file tree shows `~` paths, like the rest of the app.

### The website

- https://vibe-forge.net has been rebuilt to match. It has real screenshots, a theme switcher (press T) and a new social image.

**Update:** use Help → Update to 0.4.0, or rerun `curl -fsSL https://vibe-forge.net/install | bash`.

## [0.3.0] - 2026-09-25

The first versioned release. From here on, VibeForge tells you when a new one is out and updates itself in a terminal you can watch.

**New**

- **Updates in the app.** VibeForge checks GitHub for a newer release when it starts and every 6 hours (turn it off in Settings → Updates). When one is out, Help gets a dot; Update shows these notes, runs the update and restarts.
- **Seven languages.** English, Deutsch, Español, Français, Português (Brasil), 日本語 and 简体中文, following your system language, or pick one in Settings → Appearance. The tour, menus, tooltips and empty screens are translated so far.
- **Diagnostics.** Help → Copy diagnostics copies your versions, a few settings and the end of VibeForge's own log, ready to paste into a bug report. The log never holds your prompts or terminal output.

**Fixed**

- Closing the last terminal in a workspace now closes it, instead of starting a new shell in its place.
- Restart and Close on a pane whose program exited respond to clicks again.
- Tooltips, notifications and menus no longer hide behind the browser dock.

**Install or update**

```bash
curl -fsSL https://vibe-forge.net/install | bash
```

The installer now installs the newest release rather than the latest commit.

[Unreleased]: https://github.com/L0nE-F0x/VibeForge/compare/v2.1.0...HEAD
[2.1.0]: https://github.com/L0nE-F0x/VibeForge/releases/tag/v2.1.0
[2.0.0]: https://github.com/L0nE-F0x/VibeForge/releases/tag/v2.0.0
[1.3.1]: https://github.com/L0nE-F0x/VibeForge/releases/tag/v1.3.1
[1.3.0]: https://github.com/L0nE-F0x/VibeForge/releases/tag/v1.3.0
[1.2.0]: https://github.com/L0nE-F0x/VibeForge/releases/tag/v1.2.0
[1.1.0]: https://github.com/L0nE-F0x/VibeForge/releases/tag/v1.1.0
[1.0.0]: https://github.com/L0nE-F0x/VibeForge/releases/tag/v1.0.0
[0.8.0]: https://github.com/L0nE-F0x/VibeForge/releases/tag/v0.8.0
[0.7.0]: https://github.com/L0nE-F0x/VibeForge/releases/tag/v0.7.0
[0.6.0]: https://github.com/L0nE-F0x/VibeForge/releases/tag/v0.6.0
[0.5.1]: https://github.com/L0nE-F0x/VibeForge/releases/tag/v0.5.1
[0.5.0]: https://github.com/L0nE-F0x/VibeForge/releases/tag/v0.5.0
[0.4.0]: https://github.com/L0nE-F0x/VibeForge/releases/tag/v0.4.0
[0.3.0]: https://github.com/L0nE-F0x/VibeForge/releases/tag/v0.3.0
