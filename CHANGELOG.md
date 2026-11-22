# Changelog

All notable changes to VibeForge are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/): a version, a date, and an [Unreleased] section for what is on `main` but not tagged yet. Versioning rules are in [CONTRIBUTING.md](CONTRIBUTING.md). The notes for each tagged version are the ones published on its [GitHub Release](https://github.com/L0nE-F0x/VibeForge/releases).

## [Unreleased]

## [3.4.0] - 2026-11-23

**3.4.0: a major Viby upgrade — screenshot and image pasting on desktop and phone, persistent memory (`viby.md`) and conversation history, isolated `verify` auto-fix loops, deep multi-round inspection, 0 ms local reflexes, sentence-streamed voice, and Copilot & OpenCode reply watching.**

### Added

- **Paste or attach screenshots and images in Viby (Desktop & Phone).** Paste (`Ctrl+V`, with automatic Wayland clipboard fallback), drag and drop, or pick up to 4 images (PNG, JPEG, WebP, GIF up to 10 MB each), preview thumbnails and open them in a lightbox; Claude Code (`stream-json`) and Codex (`--image`) inspect images directly, and saved paths on disk are passed to worker CLIs in `start` and `tell` steps.
- **Persistent Viby memory (`~/.config/vibeforge/viby.md`) and conversation history.** Save cross-session preferences with *"remember …"*, `/remember …`, a `memory` step (`append` / Go-gated `set` and `clear`, with Undo), or the **Viby memory** editor on desktop and phone; **New** archives non-empty threads so you can search, switch, rename, delete, or undo threads from **History** or `Ctrl+K`.
- **`verify` step with isolated auto-fix retries and parallel wave chaining.** Run test, build, typecheck, or lint checks in a workspace or isolated copy (`retries=`, `timeout=`), automatically feeding failure output back to an attached copy's live CLI to fix and re-verify while keeping **Apply** and unsafe commands gated behind **Go**; `after: true` now waits for every CLI started or told in the current parallel wave.
- **Deeper multi-round `inspect` and composer `@` / `/` completions.** Up to 3 deduplicated inspection rounds per turn with workspace code search (`action: "search"`), file trees (`action: "tree"`), `file:start-end` line ranges, cross-copy conflict checks (`action: "compare"`), and app/run/routine diagnostics (`action: "problems"`), plus `@workspace` / `@agent` / `@cli` mentions, `/` slash commands, live activity indicators, markdown rendering, and empty-state prompt chips.
- **0 ms local reflexes, sentence-streamed Piper TTS, and Copilot & OpenCode session logs.** Instant local handling for `/go`, `/cancel`, `/new`, `/undo`, `/review`, `/remember`, `/open`, `/stop-all` and crisp navigation phrases without spawning a planner turn; Piper speaks the first sentence while generating the rest; session-log reply watching adds GitHub Copilot CLI and OpenCode (`opencode.db` / JSON) with prompt-matched disambiguation when several CLIs share a folder.

## [3.3.1] - 2026-11-22

**3.3.1: persistent split panes, in-terminal search, starter agent templates, ARM64 builds, and full security and performance hardening across Viby, Sync and the phone page.**

### Added

- **Find in terminal (`Ctrl+Shift+F`) and pane cycling (`Ctrl+Shift+[` / `]`).** Search scrollback inside any live or replayed terminal, step between panes from the keyboard, and optionally pass `Ctrl+V` and `Alt+1…9` straight through to terminal programs like Vim and tmux (**Settings → Defaults**).
- **Splitting or closing a pane keeps neighbouring terminals in place.** Neighbouring panes stay mounted without resetting their scroll position or selection.
- **Starter agent templates and one-click CLI setup.** **New agent** offers four templates (**Builder**, **Reviewer**, **Bug fixer** and **Test writer**), and empty CLI states jump straight to **Settings → Engines**.
- **Viby's copies on Home and in the rail.** Branches waiting for review show on **Home** and as a badge on Viby in the rail, and **Runs** adds a **Previous** button (`K`) beside **Next to review** (`J`).
- **Linux ARM64 builds, multi-distro installer hints and `--purge-app`.** Releases now build and smoke-test `linux-arm64` alongside `linux-x64`, `install.sh` tailors package hints for `pacman`, `apt-get`, `dnf` and `zypper` and adds `--purge-app`, and `packaging/aur/PKGBUILD` is ready for `vibeforge-bin`.

### Changed

- **Lighter Viby turns and background CPU.** Viby keeps a stable first-turn prompt for cache reuse, sends compact live-state updates on later turns, isolates 20 Hz call meter updates from the rest of the UI, pauses background polling while the window is hidden, and loads non-English schedule locales only when needed.
- **Faster run index and config reads.** The SQLite run index uses WAL mode with composite indexes, and config saves update the in-memory cache directly without re-reading own writes.
- **Pinned rail footer.** Ask, Live, Help and Settings stay pinned at the foot of the rail on shorter laptop screens.

### Fixed

- **Sync and git rescue:** unmerged index paths and unborn branches are handled cleanly during git rescue, and hidden home dot-folders can't be shared as workspaces.
- **Session and terminal reliability:** switching chats mid-send no longer drops input, gzipped run artifacts open reliably across Continue, Hand off and Markdown export, `vibeforge tell --wait` ignores older turns' replies, and CJK IME composition no longer triggers shortcuts mid-character.
- **Voice, calls and the phone page:** iOS Safari recovers from `"interrupted"` audio contexts, the phone page supports browser Back/Forward navigation and keeps recordings isolated when switching computers, and voice downloads and shutdown clean up cleanly.
- **Release packaging:** load Vite's AST parser from the staged build so `scripts/pack-release.mjs` starts cleanly on a bare checkout without root `node_modules`.

### Security

- **Per-terminal capability tokens on the control socket,** with rate limiting for outside callers.
- **Tighter Viby and Sync path checks:** Viby refuses symlinks, `.git` internals and secret files during `inspect`, gates shell redirection, destructive flags and remote URLs behind **Go**, and Sync refuses symlinked files and directories across conflicts and library sync.

## [3.3.0] - 2026-11-22

Tagged before bare-checkout release packing was fixed; superseded by **3.3.1**, which publishes these changes.

## [3.2.0] - 2026-11-21

**3.2.0: your saved agents and skills sync between your machines, with their memory, folders and CLI.**

### Added

- **Sync an agent with your other machines.** Turn on **Sync with my other machines** on an agent's Settings tab, or select several in Agents and press **Sync**. It turns up on your paired machine by itself, with its brief, memory, skills, allowed folders and CLI, and stays the same on both from then on. **Off** on either machine stops it on both, and each keeps its copy. Nothing you didn't turn on leaves its machine.
- **Skills come with the agent.** A synced agent's skills sync with it. A skill can also sync on its own, from its page in Skills.
- **Folders are found by workspace.** A folder in a synced workspace is found by that workspace, and any other folder by a workspace of the same name, then by the same place under home. A folder the other machine doesn't have yet waits on the agent's Folders tab, with **Pick a folder**, and is added by itself once a workspace of that name turns up there.
- **A missing CLI gets a stand-in.** When the agent's CLI isn't installed on the other machine, that machine's default CLI runs it there, and the agent's page says so. The machine it came from keeps its own CLI, and the stand-in steps aside once the agent's CLI is installed.
- **Edits made apart are merged.** A brief changed on one machine and memory on the other just combine. Memory written on both keeps both machines' lines. When both changed the same lines of a brief or a skill, the later change is used and the other version waits on that page under **Changed on both machines**, with **Compare** and **Put mine back**. A delete reaches the other machine once its Undo has run out, unless the agent was changed there meanwhile.
- **Viby can turn it on or off,** with `sync=on|off` on an agent or skill step.

## [3.1.1] - 2026-11-20

**3.1.1: the fixes from a full audit of 3.0.3. Viby waits for Go on more of what's risky, Sync keeps every commit, and nothing a task's agent wrote is lost on Apply.**

### Changed

- **Viby waits for Go on more of what's risky,** in Just go and on a call alike:
  - a yes, a number or Enter that answers a CLI asking to run a command or make an edit
  - Escape while a CLI is working, and a message to Claude Code that starts with `!`
  - replacing an agent's memory, and starting tasks a CLI handed out
  - a setting that lets a lead CLI apply its helpers' changes, or keeps runs for less time
  - opening a page from another site in the browser. Pages on this computer, such as your dev server, still open at once.
  - Its safe shell commands are now tests, builds, lint, typecheck and check scripts only, with no quotes. `npm run deploy` or `bun run <file>` waits for Go.
- **On a call, "go" only answers the plan Viby just showed you,** not an older one still waiting.
- **Stop ends everything left in a terminal.** A background job that ignores the hang-up, such as a `nohup`'d dev server, no longer keeps running, its port with it, after the pane closes or VibeForge quits. A program started with `setsid` is left alone.
- **Apply keeps a task's copy when the agent left files there that git ignores,** such as notes or a `config.local`, and names them, so you can take what you need before you discard it. Build and dependency folders don't count.
- **The phone page refuses Tailscale Funnel,** which would put it on the internet, instead of only warning in Settings.
- **A new agent, routine or skill named like one you deleted gets its own id** (`helper-2`) while that one's Undo is up or its old runs still name it, so it doesn't take over the old one's history, and Undo still brings the old one back.
- **Settings → Storage says when runs you keep forever pass 5 GB,** and points at the two ways to keep fewer.

### Fixed

- **Tasks Viby makes work in their own copy again,** as tasks from the board do. They had been running in your folder unless the plan said otherwise.
- **Sync:**
  - It no longer resets a branch whose commits are still arriving from the other machine: it waits for the folder to finish syncing before it sorts out git history.
  - Git's top-level lock files (`.git/index.lock` and the like) no longer sync, so a stale lock can't block git on both machines.
  - When `.env` or another dotfile changed on both machines, it is now listed under **Changed on both machines**.
  - A stash conflict keeps every stash entry, not only the newest.
  - A second conflict on the same file keeps the first saved version too.
- **Pausing a routine cancels a slot that was waiting for its folder.** A routine whose slot passed while the computer slept now shows it as missed instead of starting hours late. A daily cron time in the hour that repeats when the clocks go back fires once.
- **Continue picks up the exact session of a full-screen CLI** that prints its resume line on the way out, instead of the latest session in the folder.
- **A terminal that printed a flood of output no longer loses its last lines** (and with them its final screen) when the program ends while it is held back.
- **Reading a task's changes while its CLI still runs** no longer stages files in that CLI's copy.
- **Long dictations from the phone** get two minutes to upload on a slow connection.

### Security

- **The private Syncthing's control interface is now a socket file in its own private folder,** so another user account on the computer can't reach it.
- **A pairing request shows the other machine's device ID,** and Settings → Sync shows this one's, to check before accepting.
- **More hardening:**
  - Viby reads a file only after following its symlinks, and only inside the workspace.
  - Sync's git repair no longer runs a synced repository's fsmonitor or filters.
  - **Put mine back** refuses to write through a symbolic link.
  - The phone page caps its pairing request and times out slow connections.
  - Planner output and plan length are capped.

## [3.1.0] - 2026-11-20

**3.1.0: every list in VibeForge searches, filters, sorts and acts on several at once, the way Code's workspace list does.**

### Added

- **Every list searches, filters, sorts and selects like Code's workspace list.** Agents, an agent's Chats tab, Chat, Skills, Routines, Tasks and Runs each get the same search box (with how many match and a clear button), one **Filter and sort** menu whose filters can be on together and show what each would leave, pills for what is on, and **Reset view**. Each list remembers its filters and sort.
- **Select to act on several at once.** **Select** in any of those lists picks rows, **All shown** picks everything the list is showing, and then:
  - Agents, chats and skills: **Delete**. Routines: **Turn on**, **Pause** or **Delete**. Tasks: **Move to** To do, Review or Done, or **Delete**. Runs: **Mark as reviewed**, mark not reviewed, or **Stop** the live ones.
  - A delete of several is one toast whose **Undo** (or Ctrl+Z) brings them all back. Only deleting something still running asks first, since stopping it can't be undone.
- **Runs searches on every tab.** Review and Live search titles, prompts and folders; All still searches what runs said.

## [3.0.3] - 2026-11-20

**3.0.3: every workspace, agent and run reopens where you left it, the plan limits fill the usage panel, and Viby's call bar moves to the top.**

### Fixed

- **Each workspace keeps its own files and browser panel.** Opening Files or the browser in one workspace no longer opens it in all of them: each workspace remembers whether its panel is open and on which tab, across restarts too. Its width stays the same everywhere. A workspace you haven't touched since updating starts as the panel was before.
- **Each agent reopens on the tab you left it on.** Switching from an agent on Memory to one you left on Chats lands on Chats, in the chat you had open; going back to Chats from another tab finds that chat again too. Before, the tab you were on carried over to every agent.
- **Each run reopens on the tab you were reading.** Changes, Prompt, Transcript or Details, instead of always the screen.
- **Plan limits fill the usage panel.** When a long terminal name widens the panel, the plan cards and the token list widen with it instead of staying narrow on the left.
- **Viby's call bar sits at the top.** The Listening / Mute / Hang up bar is now centred over the view's header strip, so it no longer covers a terminal's last lines and its prompt.

## [3.0.2] - 2026-11-20

**3.0.2: plan limits drop subscriptions once their paid period ends, and read Kimi Code's newer quota windows.**

### Fixed

- **Plan limits drop a cancelled subscription once your paid access ends.** While your paid period is still running, the plan stays on the list as usual; once the provider reports no active subscription (Muse, Kimi, Claude, Codex, Grok or Gemini) or you sign out of the CLI, VibeForge removes its card, clears its saved numbers from disk, and keeps old session logs or later token expirations from bringing it back. Re-subscribing brings it straight back.
- **Kimi Code's newer quota windows.** Plan limits also read Kimi CLI's ratio-based 5-hour, weekly and monthly `usages` windows, and no longer treat a zero-limit answer as 0% used.

## [3.0.1] - 2026-11-19

**3.0.1: the tour, the help and the website catch up with 3.0.**

### Changed

- **The welcome tour knows what Viby can do now.** Its Viby step says Viby can make, change and delete your agents, skills, tasks, routines, chats and workspaces, open any of them and undo a delete, and that deleting, stopping or applying always waits for Go. Its call step says only Viby speaks, and that **Viby's voice** in Settings → Voice picks its voice or turns it off. The workspaces step mentions filtering, sorting and grouping the list, and Tasks says Viby can run a task too.
- **“Which one do I use?” points at Ask.** Calling Viby is **Ask**, then **Call Viby** (<kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>L</kbd>); it still said **Call**, which 2.24 renamed. The Ctrl+Shift+O shortcut and Viby's rail tip say what it does now.
- **Speech setup no longer assumes Whisper.** Viby's tab, the “not ready to talk” notice and the missing-model messages say a speech model, as Parakeet, Canary and Moonshine work too.

## [3.0.0] - 2026-11-19

**3.0: only Viby speaks, and Viby can do anything in VibeForge you can do with the mouse and keyboard.**

### Added

- **Viby runs the whole app.** Ask it to make, change or delete saved agents (brief, folders, skills, tier, memory), skills, routines, tasks, chats and workspaces, by voice or by typing. It can also continue, stop or hand off runs, mark them reviewed, start an agent-to-agent review, tidy run storage, change the rail and your custom CLIs, and stop a voice download. Routines take cron, *“every 2 hours”*, *“hourly”* or spoken times like *“weekdays at 9am”* and *“every Monday at 10am”*.
- **One plan can build on itself.** A workspace, skill, agent, task or routine that an earlier step makes can be named by a later step, so *“make an Acme workspace, an agent for it, and a weekly task it runs”* is one plan.
- **Viby opens exactly what you ask for.** *“Show me Atlas's memory”*, *“open the fix-login task”* or *“open Voice settings”* goes straight to that agent's tab, task, routine, skill, chat, copy, run or Settings section.
- **Undo by voice.** *“Undo”* brings back the last thing deleted, as **Undo** on the toast does.
- **Viby asks first.** Deleting, clearing an agent's memory, removing a workspace, adding or removing a custom CLI, stopping, applying, discarding and tidying runs wait for **Go**, in **Just go** and on a call too. The phone's Viby card shows the new steps the way the desktop does.

### Removed

- **Coding CLIs no longer talk back.** VibeForge used to read the first paragraph of a CLI's answer aloud, in that agent's voice. Now only Viby speaks. A CLI's answers stay in its terminal or chat, and *“what did Claude say?”* has Viby read one out.
- **Agents no longer have their own voice.** The Voice picker is gone from an agent's Settings tab. A `voice:` line in an existing `agent.yaml` is ignored and dropped the next time the agent is saved.

### Changed

- **Settings → Voice → Viby's voice holds every spoken-voice control:** on or off, talking over Viby, the voice and its preview, and downloads. Turning it off during a call stops Viby mid-sentence and keeps it quiet, and a call no longer warns that Piper is missing when spoken replies are off.

### Fixed

- **Viby plans with any Antigravity model you pick.** Antigravity's model names carry their own effort (“Gemini 4 Neon (XHigh)”), and it refused the `--effort` VibeForge always added beside one, so every model but the default failed. A model now keeps its own level; an effort you choose that differs goes on that model's base name, and if the model doesn't offer it, Viby shows Antigravity's own words saying which levels it has. Starting Antigravity as a step gets the same fix.

## [2.24.1] - 2026-11-19

**2.24.1: Viby's voice speaks again after an update, Viby asks before anything risky, and fixes across calls, speech and the workspace list.**

### Fixed

- **Viby's voice is back after an update.** Update moved the folder the app was started from, so Piper, which can't start without one, failed every reply while you could still be heard. The app now starts its helpers from your home folder.
- **Viby asks before a command that could do harm, in a call and in Just go.** A shell step goes at once only when it runs tests or a build, reads git, or lists or makes folders here; anything else, however it is spelled, waits for **Go**. Ctrl+C, a download, turning on something networked, switching Viby to Just go, and the default shell wait too.
- **Saying “no” to a CLI's question answers no.** On Claude Code's menu, where No is the third choice, it used to take the highlighted Yes.
- **A step that depends on the one before it doesn't run when that one failed**, a chain no longer waits for good on a terminal that never got busy, and **New** ends one that is waiting.
- **Telling Viby “medium” sets its effort**, not a model called “medium” that every later turn failed on. An empty value no longer keeps runs forever, and only languages the app comes in can be picked.
- **Viby's panel during a call:** a step you edit is saved before you say go, an error while hearing you shows in the call's bar, the first key that opens the message box is kept (with the cursor after it), the review list doesn't open by itself, and a step that sends a key or runs a command shows which.
- **Hearing you on a call:** the words shown while you speak no longer hold up the final transcript, a speech model that took too long can't answer the next thing you say, a runtime that fails to unpack keeps the model it came with, and Viby's voice stays quick to start through a long call.
- **The workspace list:** the count of uncommitted files is the workspace folder's own, not the whole repository's; git is asked again when workspaces or runs change, not many times a second during a sync; and a saved filter doesn't say “nothing matches” before git has answered.
- Inspecting “the rate limit handling” reads it instead of your plan's limits, and a folder Viby makes stays in your home, projects or a workspace.

## [2.24.0] - 2026-11-18

**2.24.0: one Ask button for Viby, where you type or call; a redrawn pixel Viby that stays readable and still; and a tour that catches up with calls.**

### Changed

- **One button for Viby.** **Call** at the foot of the rail is now **Ask**, with Viby's pixel V. Clicking it opens Viby's bar over any view, where you type what to start or press **Call Viby**. In Viby's own tab it starts the call. On a call it reads **On call** and hangs up, as before. <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>O</kbd> and <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>L</kbd> work as they did.
- **Viby's tab has the message box open next to Call Viby.** Typing no longer hides behind the keyboard icon. A call still tucks it away, and hanging up brings it back.
- **Viby's pixel character is redrawn.** Its face is a rimmed screen now, not an open notch, with eyes that still read at rail size and a mouth that moves while it speaks. The tips of the V light up while it listens, its eyes glance around while it thinks, and the spark goes out when you mute. Its body holds still between poses, so it no longer jitters.
- **The tour's call step is up to date.** It points at **Ask** and says that safe steps happen at once on a call and that more than one speech model can hear you.

## [2.23.0] - 2026-11-18

**2.23.0: Viby's panel is the call, with a pixel V and chips you can tap; faster speech models that stay on this machine; and a workspace list you can filter, sort and group.**

### Added

- **Viby's panel is the call.** The Vibe tab opens on a pixel V and one **Call Viby** button, with a line of what it sees: workspaces, running CLIs, and copies waiting for review. A live call shows Listening, Thinking, or Speaking, and your words appear while you are still talking. Viby's reply keeps pace with its voice. Finished work becomes chips you can tap: open that terminal, review a copy, or see what it checked. Hanging up ends the audio and leaves the thread. <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>O</kbd> over Code is the same thread in a short bar.
- **Faster speech models, still on this machine.** Settings → Voice can hear with Parakeet, Canary, or Moonshine as well as Whisper, including smaller Whisper builds. Parakeet and Canary cover more than English; Moonshine and the smaller English Whisper builds are for short phrases on a laptop, and one compact Whisper build hears many languages. The first of the new models also brings the program that runs them. Each row says how quick it is and which languages it hears. Nothing is sent off this computer.
- **Viby can change settings.** It can see which CLI plans for it, the model and effort, and which speech models and voices are already here. Ask it to switch those, download a model or a Piper voice, or change appearance, sound, the tray, usage, the phone page, sync, and how long runs are kept. A change that turns the network on still waits for you to say go. Settings → Viby has its own effort choice.
- **A long workspace list can be narrowed and grouped.** The filter menu combines Terminals open, CLI working, Waiting for you, Copy waiting for review, Uncommitted changes, and Synced, and each choice shows how many match. Sort by name, your order, parent folder, recent activity, or uncommitted changes, and group by parent folder. Search also matches the git branch. A clean workspace stays quiet; a dirty one shows how many files changed, and a copy waiting for review can be opened from its row.

### Changed

- **Switching Viby's planner clears its effort.** The next CLI has its own levels, so the previous choice does not come along.

## [2.22.0] - 2026-11-18

**2.22.0: faster, natural calls with Viby (warm voice, mute, barge-in while thinking, natural hang-up, and safe steps run at once); unblinded workspace and terminal inspection, step chaining, and full VibeForge workbench controls.**

### Added

- **Viby inspects workspaces, terminals, diffs and quotas, chains multi-step plans, answers TUI prompts, and drives the workbench.** New `inspect` steps read terminal screens, CLI replies, copy diffs, workspace git status/files, and plan limits/token usage in the same turn so Viby can diagnose errors and brainstorm with real context. Steps with `after: true` wait for the preceding CLI turn to settle before starting. Viby notices when a CLI is blocked on an interactive prompt (such as folder trust) and speaks up, `key` steps answer `y/n`, numbered menus, `Enter` or `Esc`, `shell` steps open terminals or run commands, and `workbench` steps create folders, open git branches, drive the browser dock preview, split or zoom panes, open diffs, and mark runs reviewed.
- **Mute, natural hang-up, and barge-in while Viby thinks during a call.** The call bar now has **Mute** / **Unmute**, talking while Viby is still thinking cuts the turn short to hear what you said instead, and natural goodbyes ("you can end the call now, Viby, thank you" — alone or alongside a final request) sign off and hang up automatically unless you speak up again before it finishes.

### Changed

- **Calls act at once on safe steps and answer faster.** During a call, safe or isolated steps (starting a CLI in its own review copy, telling a CLI, creating a workspace, running a task or routine, and crisp "switch to / open …" navigation) run immediately without waiting for "go", while stopping a CLI, applying or discarding a copy, or editing uncommitted work in place still wait for confirmation. Piper stays warm in memory for the length of a call, Whisper skips slow temperature-fallback retries and listens for current workspace files, branches, tasks and routines, and Claude Code defaults to Haiku during calls when no planner model is pinned.

### Fixed

- **Starting a CLI from a call with Viby no longer opens two panes showing the same terminal.** Following the plan into Code and placing the new CLI raced to load the workspace's panes and each gave the one PTY a pane of its own, so both panes mirrored one session and closing either stopped the other.

## [2.21.0] - 2026-11-18

**2.21.0: one phone page for all your computers, set up by scanning a QR code; search, filter, sort and batch remove for a long workspace list; and a key to call Viby.**

### Added

- **One phone page for all your computers.** The page now shows the computer it is looking at by name, on the landing page and (once there are two) on the desk. Tap it for **Computers**: each one with who is working or waiting there, a tap to switch, and **Add a computer**. Adding takes the other computer's QR code from its Settings → Phone, scanned from inside the page (Chrome on Android), or its name and pairing code typed in; the name alone is enough for a machine on the same tailnet. Each computer keeps its own pairing code, the phone opens on the one it showed last, and a computer whose code was replaced asks for it again by name while the others carry on. **Remove** takes an added computer off the phone.
- **Settings → Phone is four steps that tick themselves off:** turn the page on, connect this computer and the phone with Tailscale, share the page, open it on the phone. VibeForge asks this computer's own `tailscale` where things stand (`status` and `serve status`, nothing over the network, and it changes nothing), so only the step that is left is spelled out: where to get Tailscale, the command to connect it, or the one command that shares the page. It says so when Tailscale Funnel has the address open to the internet.
- **A QR code pairs the phone.** Step 4 shows the page's address and, behind **Show QR code**, a code that holds the address and the pairing code: point the phone's camera at it and the page opens already paired, with nothing to type. The code is taken out of the address bar as soon as the page has read it, and is never sent as part of a request.
- **The phone page opens when its computer is off.** The page keeps a copy of itself on the phone and uses it when the computer it was installed from doesn't answer within four seconds, so with two computers the app still opens and shows the other one. The computer's own files always come first, so an update still reaches the phone the next time it opens.
- **A long workspace list is easy to get around.** Above Code's list of workspaces: a **search** box (a workspace's name, by letters in order as Ctrl+K finds it, or a piece of its folder; Escape clears it), and a **filter and sort** menu that shows all, only the ones with terminals open, only the ones waiting for you, or only synced ones, in your own order or **by name**. The filter and sort are remembered; dragging to reorder works while the list shows all of it in your order.
- **Remove several workspaces at once.** **Select** turns the rows into checkboxes; **All shown** picks everything the search and filter leave, and **Remove** asks once for all of them (the folders stay on disk). Escape or Select again ends it. Removing one from its ⋯ menu works as before.
- **A key for calling Viby.** <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>L</kbd> starts a call from any view, terminals included, and hangs up again. It is on the shortcut sheet, the Call button's tooltip and the tour.
- **The tray shows an open microphone.** While a call is on, the tray icon gets a mark in its upper corner, its tooltip says the microphone is open, and its menu has **Hang up the call with Viby**. Closing the window to the tray during a call says so in a notification each time.
- **Settings → Voice says what a call can do here**: whether the speech detector was found, and whether PipeWire's echo cancellation can be asked for (which decides if you can talk over Viby without headphones).

### Changed

- **The phone page's server answers a page that was loaded from another machine on the same tailnet**, which is what lets one page show two computers. It answers no other page (a browser's cross-origin check, with the allowed origin named per request), still asks for the pairing code on every request, and the page's own policy lets it send requests to its own tailnet's machines and nowhere else. The command in Settings and the README now starts with `sudo`, which `tailscale serve` needs on Linux unless you made yourself its operator.
- **The welcome tour catches up with the app.** Three new steps: calling Viby (the rail's Call button, and what voice needs), CLIs asking each other (`vibeforge tell`, `vibeforge task`, **Send to…** on a pane's title bar), and what Settings adds (your phone, sync with your other machine, voice, themes and languages). The rail's step says a view glows when a CLI in it is waiting for you, and Viby's says it also runs agents, tasks and routines and takes you to a workspace or view. Sixteen steps, about two minutes.
- **Which one do I use?** (the tour, Help and the README) gains two rows: talking it through on a call, and the same workspace on your other machine.
- **A call says what to do when it starts.** For its first eight seconds, or until you speak, the bar reads "Listening. Say something and pause; “hang up” ends the call." After that a quiet call shows in the rail alone, as before.

### Fixed

- **The tour's two terminal steps no longer blank for a second on a first run.** With no terminal open yet they point at the empty workspace, which says the same thing, instead of waiting for a pane that isn't there.
- **Settings → Phone gives the computer's own address, not one it used to have.** Tailscale Serve keeps the entries of a name a computer had before it was renamed, and that old name no longer opens anything; the address and the QR code could point there, so the phone got nothing. Only the computer's current Tailscale name counts now.
- **A plan that can't find what to show says so.** "Nothing called “x” to show: no running CLI, workspace or view", where it used to say "No workspace called “x”. Pick one." with nothing to pick from.

## [2.20.0] - 2026-11-18

**2.20.0: call Viby. Talk to it from anywhere in the app and hear it answer, watch it work on screen, and talk over it when you've heard enough.**

### Added

- **Call Viby.** A **Call** button at the foot of the rail (and **Call Viby** in Viby's panel and its bar) opens the microphone and keeps it open: say something, pause, and it goes to Viby as if typed in its box; Viby's answer is read aloud, and it listens again until you hang up. It works from any view, so you can talk to Viby while you watch Code. The rail's button stays lit with the microphone's level for as long as the call is on, and a bar comes up only while something is happening: you are heard, Viby is thinking or speaking, or a plan is waiting.
- **Plans still wait for Go in a call**, as **Show me first** / **Just go** says. Viby reads the plan and asks; saying "go" or "cancel" on its own answers it at once, without another planning turn, and the card's buttons work as before. "Hang up" ends the call.
- **It listens for speech, not for noise.** A call tells a voice from a keyboard, a door or music with the Silero voice-activity model (MIT, 885 KB), which now comes with VibeForge and runs on this machine. Without it (a build that lacks the file) a call goes by loudness, as dictation's meter does.
- **Talk over Viby.** Start talking while Viby speaks and it stops to listen, where it can't hear itself: for the length of a call VibeForge asks PipeWire to cancel the speakers' sound out of the microphone (its own echo-cancel module, in a process that ends with the call; your sound setup is not changed), or you tell Settings → Voice you wear headphones. Elsewhere, and under **Never**, one side talks at a time as before: the microphone isn't listened to while Viby speaks, and **Stop reading** on the bar cuts it off.
- **Viby never takes its own voice for yours.** What is heard while Viby speaks is checked against what it was saying; its own words coming back are dropped, and after one clear case talking over is off for the rest of that call. So "go" said over "Say go, or cancel" has to be said again once Viby is quiet. "That's enough", "wait" or "got it" only stop it.
- Holding the dictate key during a call still dictates into the box or terminal with focus, and the call hears none of it.
- **Viby knows what you're looking at.** Typed or spoken, each request tells Viby the view you're in, and in Code the workspace and the terminal with focus, so "tell this one to run the tests" and "start Claude here" mean the ones in front of you. A message you ask it to pass on goes word for word.
- **"Switch to …", "show me …".** Viby can open any workspace in Code and any view (Tasks, Runs, Settings and the rest), not only a running CLI's terminal. Showing changes nothing, so a plan that only shows goes at once, even under **Show me first**.
- **The window follows Viby during a call.** A CLI it starts or tells comes up in Code as it happens, without VibeForge being raised over another app you have in front.
- **Viby speaks up.** During a call, when a CLI Viby started or told ends its turn, Viby says so and reads the first lines of its answer ("Claude Code in api finished its turn. It says: all 12 tests pass"). It waits for a moment when nobody is talking and never cuts in. The same note in Viby's panel now carries those first lines, call or no call, and a CLI Viby only told gets a note too.
- **"What did Claude say?"** A new **Read out** step fetches a running CLI's last answer: all of it on the plan's card, and in a call the start of it aloud (ask for "all of it" for the rest), with its terminal brought up beside it. Reading changes nothing, so it goes at once. The answer comes from the CLI's own session log (Claude Code, Codex, Grok Build, Kimi Code); for the others the end of the screen is on the card and nothing is read aloud. The answer is never sent to the CLI that plans.
- **Everything stays on this machine**, as with dictation: whisper.cpp hears, Piper speaks, and the silence between the things you say is dropped as it arrives. Without Piper or a voice, the answers show on the bar instead.

## [2.19.0] - 2026-11-17

**2.19.0: sync a workspace with your other machine. Pick the workspaces, pick the direction, and pick up at home where you left off at work.**

### Added

- **Sync a workspace with another machine** (Settings → Sync, off until you turn it on). Pair two machines once by pasting one's code into the other, then right-click a workspace in Code and choose **Sync to …**. Only the workspaces you pick are synced. The other machine asks where to put it and adds it as a workspace. Files go straight between the two, encrypted, over your local network or Tailscale. With a firewall on, Settings → Sync shows the one `ufw` command that lets your other machine connect.
- **Both ways, send only or receive only**, per workspace, changed any time from either machine. **Files only** leaves git history out; otherwise your branch, commits and stash arrive with the files. `node_modules`, `target` and `.venv` never sync.
- **No conflict copies left in your folders.** When both machines changed a file before they met, the later change is used and the other is kept for you: **Compare**, **Keep the other's** or **Put mine back**. When both committed on one branch, the other commits are kept on `<branch>-from-<machine>` with **Merge now**.
- **See when the workspace is in use over there.** A synced workspace's row shows its direction and state, and says when a CLI is working in it on the other machine.
- **Syncthing is built in.** VibeForge carries one pinned, unmodified Syncthing (MPL 2.0, with its license and source link) and runs it privately while sync is on: no discovery servers, relays, NAT traversal, usage or crash reports, or self-upgrades. Nothing to install, and a Syncthing of your own is left alone. The download grows by about 12 MB.

## [2.18.0] - 2026-11-17

**2.18.0: dictate from the couch. Pick your own dictate key or a mouse button, and send with a click. Runs can mark the whole review list reviewed at once.**

### Added

- **Keys and buttons for dictation** (Settings → Voice). Change the dictate key from Ctrl+Shift+Space to any key with Ctrl, Alt or Super, or an F key on its own; a key another shortcut already uses, or one you type with, is refused with the reason. Tooltips, the shortcut sheet and Viby's box show the key you picked.
- **Dictate with a mouse button.** Pick the back or forward side button, or the middle one, and it works like the mic: hold it and let go, or click it, talk, and click again. The words go to the box or terminal you last clicked. A side button picked here no longer goes back or forward (the other one still does), and the shortcut sheet says so.
- **A Send button after dictating.** Once dictated words are in a terminal, a small **Send** shows in its lower right corner: a click presses Enter there, the same as pressing it yourself, so talk-back still works. By default it comes after the mic or the mouse button and not after the keys; Settings → Voice can show it after any dictation, or never. Enter, Ctrl+C or Esc in the terminal, a new dictation or × put it away. Message boxes keep their own Send.
- **Mark all reviewed** at the top of Runs → Review clears the list without opening each run, as Home's button does.

### Fixed

- **Talk-back after dictating into a terminal** is no longer dropped by a click elsewhere, a mouse move or an arrow key before you press Enter. Claude Code has the terminal report focus and the mouse as input, and any of those reports used to count as giving up on the dictated words; now only Ctrl+C, Ctrl+U or Esc does.

## [2.17.2] - 2026-11-16

**2.17.2: terminals draw in your terminal font again.**

### Fixed

- **Terminals draw in your terminal font again.** Since 2.17.1, terminals drawn on the graphics card showed tiny letters in a proportional font, spread out across their cells, and were hard to read. Electron 45.2.3's Chromium ignores a canvas font that starts with a space, which is how the terminal's renderer names its font for upright text, so it fell back to 10px sans-serif. VibeForge now hands the font over without the space, and the smoke test checks it on every build.

## [2.17.1] - 2026-11-15

**2.17.1: Viby's new task, routine and agent steps do what the board and Chat do; `vibeforge tell` flags, the phone's mic and the plan card work as before 2.17.0. From a review of 2.17.0.**

### Changed

- **Viby sends less with each message.** Each workspace's recent runs no longer go with every planning turn (on a desk of 18 workspaces that was about 700 tokens a message, with the start of each past prompt); a lookup searches past runs when you ask about one. A lookup reads folder names only in your projects folder and `~/Projects`, no longer in `~/Documents` or `~/Desktop`.
- **Electron 45.2.3** (from 45.2.1), with Chromium's latest security fixes and a Wayland crash fix.

### Fixed

- **One VibeForge icon, in your theme's colours,** in notifications, the tray and the app launcher, as in the window. A launcher entry made before 0.4.0 still had the old logo, which notifications showed beside the new one, and a voice message and Settings' **Send a test** came without an icon.
- **Viby runs a task the way Execute does.** A task that had run before was picked up in its last session with no instructions typed in; it now starts again with them. A task or routine in the workspace itself waits its turn while another CLI is busy there, as it does from the board, and its step says what it's waiting for. A new task in a folder that isn't a git repository (or has no commit yet) runs in the folder itself instead of failing.
- **A saved agent stays in its allowed folders** when Viby starts it, as it does from Chat and Tasks, and one started in its own copy is told to work in that copy, not in the folder it was copied from.
- **An agent whose name holds a CLI's** ("Grok Reviewer") starts as that agent, not as the bare CLI.
- **Routine steps** understand "pause", "off", "turn on" and the like. A word Viby can't place is asked about on the card; it no longer runs the routine instead.
- **`vibeforge tell` and `vibeforge task` take `--wait`, `--title` and `--timeout` after the message again,** as in 2.16. In 2.17.0 they became part of the message, and the answer wasn't waited for.
- **The phone's mic keeps what you said when a press is interrupted,** and keeps listening when the phone first asks for the mic, as before 2.17.0, which threw the recording away.
- **On a task waiting its turn, In a copy** starts it once, at the terminal's size, without an "already running" error.
- **The plan card:** typing a new workspace's name or folder no longer drops a space or a key when you pause. Lookup, task and routine steps say what they will do (Look up, Run task, New task, Run routine, Turn on or off routine), on the computer and the phone, and a task or routine that isn't there is named as one.
- **Lookups** match a folder by its own name, so the folders inside one match no longer push the others out of its eight results, and read the disk without holding up the window.
- **Viby asks its planner again** only when the answer promised to do something without a step for it, not when it was waiting on you ("once you tell me which branch").
- A terminal whose recording started and stopped in quick succession could go on recording after its run had ended.

## [2.17.0] - 2026-11-14

VibeForge's orchestrator becomes **Viby** — an anthropomorphic, voice-aware companion with situational awareness across workspaces, agents, tasks and routines, plus fixes from a full codebase audit.

### Added

- **Viby: VibeForge's anthropomorphic orchestrator.** Maestro is now **Viby** (recognizing "Viby", "Vibey", "Vibe" and "Maestro" by voice). Switching between planning CLIs (Grok Build, Claude Code, Codex, Antigravity CLI) keeps the conversation going by carrying a recap of recent turns into the new planner.
- **Two-beat `lookup` step.** Ask Viby to find a past session, branch or project folder on disk and it emits a `lookup` step; VibeForge immediately searches run history, workspace git branches and project folders on disk (`~/Projects`, `~/Documents`, `~/Desktop` and the projects folder up to depth 3) and hands the findings back in the same turn so Viby can plan the real `workspace` and `start` steps right away.
- **Full situational awareness, Agents, Tasks and Routines in Viby.** Viby knows each workspace's recent runs, your saved **Agents**, **Tasks**, **Routines** and default CLI. A `start` step can launch a named Agent (with its brief, memory and skills) or use your default CLI when none is named; `task` steps run or create and execute board tasks; `routine` steps run a routine now or enable/disable it.

### Fixed

- **2026-11-14 full codebase audit:** fixed planner empty-promise stalls and Grok resumed-session stale workspace lists; atomic temp-file writes in `writeText`; symlink-cycle protection in skill copy; ReDoS and path traversal guards across `replies.ts`, `usage.ts` and `vcs.ts`; `execFile` buffer and timeout limits; PTY host write backpressure and terminal capture flush ordering; WebGL context leak on unmount; and Phone Companion SSE overlap, mic stream cleanup and focus restoration.

## [2.16.0] - 2026-11-12

**2.16.0: Maestro makes workspaces, starts each CLI on the model and effort you ask for, and tells you when one is done; Apply keeps every byte; and a long list of fixes from a full audit.**

### Added

- **Maestro makes workspaces.** Say "make a workspace called Star Ledger as a git repo and start Claude there" and the plan has a **New workspace** step: its name, its folder (in Settings → Maestro's new **New workspaces go in**, or the folder most of your workspaces sit in, else `~/Projects`) and whether to run `git init`. Go makes the folder and adds it to Code; a folder that's already there is only added, never written into or emptied. Later steps in the same plan can work in it.
- **Model and effort for each CLI Maestro starts.** "Start Claude on opus at high effort" starts it with `--model opus --effort high`. Each start step on the plan card has a model and an effort, with only the levels that CLI takes: Claude Code, Grok Build, Codex, Antigravity CLI, Copilot, Muse and Pi have efforts; Kimi and Cursor Agent take a model only.
- **Maestro opens a CLI where you are.** "Open Claude in VibeForge" starts it in the workspace itself, with no branch, copy or first instruction. A branch left empty on the card means the same.
- **Maestro hears back.** When a CLI it started finishes a stretch of work, its conversation says so, with what changed, **Open in Code** and **Review**; when one closes by itself it says that too. Asking "how's it going?" gets an answer that knows what each CLI was asked, which branch it's on and which copies wait for review.
- **Apply, Discard and Show in a plan.** "Apply the fix-tray copy", "throw away the parser copy" and "show me Grok" are steps now. Apply, Discard and Stop always wait for Go, even under **Just go**.
- **The plan card warns** when a workspace has edits you haven't committed, since a copy starts from the last commit and leaves them behind.
- **On the phone:** **Forget this phone** in its settings; the pairing code is hidden as you type it, with Show; Settings → Phone warns when the page was reached through a tailnet name without Tailscale's sign-in header (that's what `tailscale funnel` looks like); and the page reloads itself once this computer runs a new version.
- **Keyboard:** menus open on their first item and move with ↑/↓/Home/End; the Files tree moves with the arrow keys; Ctrl+N/Ctrl+P in Go to anything and F2 to rename a workspace are on the shortcuts sheet.

### Changed

- **Maestro answers sooner.** Claude Code and Grok Build plan at low effort, and Claude Code plans without loading your MCP servers.
- **Maestro matches names better.** "GitHub Copilot" and "Copilot CLI" find Copilot; a two-letter name such as Pi no longer matches inside longer words.
- **The in-app Update runs the installer of the release it found,** checked against the SHA-256 GitHub lists for it, instead of the website's `/install`. A git checkout updates with `npm ci`.
- **Releases are built and published in two steps:** the build runs with a read-only token, and the publish step, which runs none of the project's code, attaches a build provenance attestation.
- **The installer** downloads nothing when you already have the newest version (`VIBEFORGE_FORCE=1` reinstalls), runs one at a time, keeps your previous copy until the new one is unpacked, puts the old copy back if it's stopped midway, checks the ready-made terminal module loads on your system (and builds from source if not), and reads only a 404 as "this release has no ready-made build". Uninstalling names every folder VibeForge used.
- **Lighter on the phone's data:** the page asks again only for what changed, compressed, and plan limits no longer hold up the rest.
- **The website** shows everything without JavaScript, and serves HSTS.

### Fixed

- **Apply keeps every byte.** A text file in an older encoding (Latin-1, Windows-1252, Shift-JIS) came through Apply with its special characters replaced, and its copy was then removed. A repository a CLI cloned inside its copy was silently left out; now the copy stays and Apply says so, and a nested repository with no commits gets a plain message naming the folder.
- **The browser dock no longer stops working** once a page in it closes itself, and closing the window no longer throws.
- **Arrowing through a list no longer hands the keyboard to a live terminal,** where your next keys (Enter included) went to the CLI.
- **VibeForge no longer waits on a slow or prompting shell profile to open its window.**
- **No more spell-check download from Google** on first start; the update check and voice downloads carry no cookies from the browser dock; and the Plan limits hint names Google, which it asks for Antigravity.
- **After an update, before you restart,** every view still opens, and VibeForge offers Restart rather than Update now.
- **Agent talk:** `vibeforge task --wait` reports back as a message when the asking CLI's command gave up first; several hand-offs at once respect the working limit; Review with… and Send changes from a subfolder include files that were already edited.
- **Runs count only their own changes,** not edits that were already in the folder when they started.
- **Double starts:** pressing Continue twice, or two messages to a new chat at once, start one session.
- **Routines on an interval** no longer fire twice the night daylight saving ends.
- **Plan limits** no longer predict "full" after the window resets; token days stay right after a change of time zone.
- **Terminals:** opening a pane while its CLI prints no longer shows output twice; a pane closed while starting no longer leaves its CLI running; new panes no longer open hidden behind a maximized one; a finished run's screen copies with Ctrl+C and lets app shortcuts through; terminals that die with the terminal host show as ended; the terminal host ends its terminals properly when the terminal VibeForge was started from closes.
- **Smaller fixes:** "Put it back in Needs review" stays put; an agent's Good at with two spaces no longer saves in a loop; the New agent dialog keeps what you typed; removing a CLI in Settings has Undo and New code asks first; deleting the first agent or skill opens another; double-clicking a file opens it without pasting its path twice; Ctrl+Shift+Enter closes the Write box and Ctrl+Enter sends; the tour keeps the keyboard to itself; a dictation started by click survives the window losing focus; terminal links show where they really go; long lists say where they stop; the run Details tab speaks your language.
- **On the phone:** an error stays on screen until you close it; with VibeForge closed, a correct pairing code says the computer can't be reached instead of "didn't match"; nothing waits forever on a stalled link; Go no longer starts a plan whose last edit didn't reach the computer; text from the phone is cleaned of control characters before it reaches a terminal.
- **Under the hood:** saved review patches are capped and tidied after three days; a quit waits for a deleted task's or discarded copy's branch to go; a busy phone port is tried again; the terminal host's errors reach the log; the reply watcher no longer loses long turns.

## [2.15.0] - 2026-11-09

**2.15.0: installing and updating take seconds, with nothing to compile, and a one-screen guide to which part of VibeForge fits what you want to do.**

### Added

- **Which one do I use?** Ten lines from what you want to where to do it: a quick question goes to Chat, an agent's work in its own copy to Tasks, a job on a schedule to Routines, a CLI asking another to Settings → Agents together, and so on. It's a step in the welcome tour, an item in Help in the rail (where each place is a link), and a section of the README.

### Changed

- **Installing and updating take seconds, with nothing to compile.** Each release now carries a ready-made build for x86-64 Linux. The installer downloads it (about 100 MB), checks it against the release's SHA256SUMS and swaps it in, so `git`, `base-devel` and `python` are no longer needed and any Node from 20 on will do. It still builds from source for a release without one, on another CPU, with `VIBEFORGE_BRANCH`, or when you set `VIBEFORGE_FROM_SOURCE=1`, and says which way it went. A copy the installer made switches over at its next update, and the git checkout it replaces stays in `~/.local/share/vibeforge-app.previous`. A git checkout you build yourself keeps building.
- **The website's Maestro screenshot** shows Maestro as it is now: its name, and a plan whose steps wait for Review, Apply or Discard.
- **Under the hood:** the five largest files (the main process, the message desk, the store, the Code view and the phone page) are split into parts with one job each, every keyboard shortcut comes from one list that also feeds the terminal pass-through and the Help sheet (which now lists Ctrl+Z), and the terminal host, `vibeforge tell` and the phone page are type-checked like the rest of the code. Nothing changes in how they work.

### Fixed

- **Maestro's Running list** no longer shows a scrollbar when everything fits (seen at 1.25 scale).
- **A terminal no longer takes focus from a menu or dialog you just opened.** When a CLI appeared on screen while Ctrl+K or a dialog was open, the new terminal took the keyboard and Esc stopped closing what you had open.
- **A half-edited `engines.json` is left for you to finish,** as `settings.json` already was, instead of being set aside the moment VibeForge read it. Run search takes `%` and `_` as plain characters.
- **Agent talk:** Stop during `vibeforge task --wait` says a person stopped it, not that the task ended; a handed-out task whose Start fails stays in "N to start"; `vibeforge apply <title>` picks the asking CLI's own task when two share a title; a late answer is cleaned before it's sent and saved.
- **Terminals lost when the terminal host crashes** end like any other, so a spoken answer waiting on one stops waiting.
- **On the phone:** pairing with the computer out of reach says so in your language and lets you try again; Send clears only the box it sent from; a session that's gone no longer slows the desk's updates.

## [2.14.1] - 2026-11-08

**2.14.1: VibeForge runs on Electron 45.**

### Changed

- **Electron 45** (Chromium 156 and Node 24.22), the newest line, for its security fixes. VibeForge is now built with Vite 8 and checked with TypeScript 7. Nothing changes in how the app works.

## [2.14.0] - 2026-11-08

**2.14.0: Maestro's work comes back for review, Apply works over your own edits, and a long list of fixes from a full audit: safer updates, a phone that disconnects when you say so, and a faster desk with many CLIs open.**

### Added

- **Maestro's work comes back for review.** Each CLI a plan starts on a new branch now works in its own copy, as a task's does. When it's done, its step on the plan card and the **To review** list beside the conversation offer **Review** (the diff, file by file), **Apply** (its changes come into your workspace as uncommitted edits, and the copy, its branch and its workspace are tidied away) and **Discard** (with Undo). Before, those checkouts piled up beside your projects with no way back.
- **Undo when you delete an agent.** Its folder, memory and routines go to the trash together, and **Undo** brings them all back. You no longer type its name to delete it; VibeForge asks only when a CLI is running as that agent.
- **Shift+Esc closes a sheet from inside its terminal.** Esc typed into a terminal now reaches the CLI (Claude Code uses it to stop a turn) instead of closing the sheet around it.
- **Maestro in the first-run tour,** with Ctrl+Shift+O, and the tour's view keys now read Ctrl+1…9.
- **The principles, written down.** [docs/principles.md](docs/principles.md) says what VibeForge does and won't do, and names the update check as the one networked call that is on by default. [SECURITY.md](SECURITY.md) says how to report a vulnerability privately.

### Changed

- **One name: Maestro.** The page, Settings, shortcuts, messages and the README all call it Maestro now, in every language.
- **No more example prompts in Maestro.** The three sample sentences under "Tell VibeForge what to start" are gone from Maestro, its bar and the phone's Maestro page. The box and its hint are all you see now.
- **Maestro plans with a CLI you have.** Until you pick a planner in Settings → Maestro, it uses Grok Build when that's installed, else the first of Claude Code, Codex and Antigravity CLI that is. Before, a machine without Grok Build was told nothing could plan.
- **A message from Maestro to a running CLI waits for it to be free,** through the same queue as CLIs' messages to each other, and goes in as you wrote it. It no longer lands mid-turn, after Stop, or at a bare shell prompt once the CLI has quit.
- **Faster with many CLIs open.** Token counts read the CLIs' logs in slices, so a first scan of gigabytes no longer freezes the window. Settings, engines and agents are read from disk only when they change. The run page, lists and toasts re-render only when what they show changes. The fast terminal renderer goes to the terminals you can see. The glow costs less to draw and rests while VibeForge isn't the focused window. Reply watching reads only what's new in a log.
- **A pane that floods output keeps memory in check.** The terminal host holds back a program that prints faster than its screen can follow, instead of growing without limit.
- **Tasks and routines waiting for their folder survive a restart,** and take their turn again once the CLIs the window reopens have started.
- **Saved messages and patches are kept for three days,** not just the newest forty, and never while a message still points at one.
- **Whisper's server stops after two idle minutes,** not ten.
- **The website loads nothing from Google.** Its fonts are served by the site itself. It also gained a favicon, a sitemap, a 404 page, clearer faint text and a page screen readers can follow.
- **Updates can't leave VibeForge broken.** The installer builds an update beside the installed copy and swaps it in only once the build has worked; the copy it replaced stays in `~/.local/share/vibeforge-app.previous`. A download of the installer that is cut off runs nothing. `--uninstall` also removes Start at login, and the installer finds Muse, Pi and Hermes among your CLIs.
- **Releases come only from a tested commit on `main`,** and each one carries `install.sh` and its SHA-256.

### Fixed

- **`vibeforge apply` reaches the app.** A lead CLI's `vibeforge apply <task>` started a second VibeForge, which quietly closed, so the lead was told nothing and nothing was applied.
- **An update with no network says it failed.** It used to say "Updated" and offer a restart into the same version.
- **Apply works over your uncommitted edits.** Applying a task's copy failed with "The changes don't apply" whenever you had uncommitted edits in a file the copy also changed. Each file is now merged three ways against what's on disk: changes to different lines both go in, the same lines get conflict markers, and a binary or a file one side deleted keeps your version and says so. Git's own index is never touched.
- **Escape closes only the top layer.** Esc on a task's menu, or on a question over a sheet, used to close the sheet too.
- **Focus comes back** after closing Ctrl+K or the Ctrl+Shift+O bar, so you can type into the terminal again without clicking it.
- **Shortcuts wait under dialogs.** Ctrl+Shift+D, E, W and M no longer act behind a dialog, holding Ctrl+Shift+D opens one shell rather than one per key repeat, and a second question no longer leaves the first unanswered.
- **Pane sizes are kept** after a restart.
- **Two CLIs a plan starts in the same workspace each get a pane.** One of them could end up running with nowhere to see it.
- **Links in terminals open.** Clicking a link a CLI prints (Claude Code, gh and compilers do) showed a warning and then nothing. The exit line under an ended terminal is translated too.
- **Agent talk keeps to its limit.** Messages queued while a CLI was busy all slipped past the limit on how many CLIs may send without a person, and a terminal's automatic answers to a CLI counted as a person typing, which lifted Stop.
- **Undo after deleting a task brings back a working copy,** even if another task tidied the repository's copies in the meantime. A copy's branch that already has commits is kept under a new name rather than reset.
- **Runs show after you restore the data folder under another home folder,** and cleaning up never reaches outside the data folder.
- **Restart after an update opens the window,** not a hidden copy in the tray, when VibeForge was started at login.
- **A broken run index no longer stops VibeForge opening.** It's set aside and rebuilt; a start that still fails says why and where the log is, instead of leaving a copy with no window.
- **Closing with live terminals no longer stalls them** while VibeForge asks, and **Quit no longer hangs** on a connected phone or brings the terminal host back mid-quit.
- **A model download on a full disk fails and can be tried again,** instead of hanging until restart.
- **On the phone, a recording that reaches three minutes is kept,** not refused, and the page keeps updating on a slow link instead of stalling.

### Security

- **Electron 44.10.2,** which fixes two high-severity advisories in the version 2.13.0 ran on.
- **Only VibeForge's own page gets the app's bridge.** A link or script pointing the window at another page, a file on disk included, is refused, and calls from any other page are turned away.
- **Turning the phone page off, or making a new code, disconnects a phone at once.** A phone that kept polling used to keep control with the old code. The page also answers only to this computer's own names and its tailnet name, can't be shown in another site's frame, and says nothing about this computer before pairing.
- **settings.json, which holds the phone code, is readable by you only.**
- **Whisper models and Piper voices are pinned to a release and checked** against their size and SHA-256 before they're used.
- **The control socket's fallback lives in a private folder** when there's no runtime folder, and VibeForge's debugging switch is kept out of terminals and planners.

## [2.13.0] - 2026-11-07

**2.13.0: Maestro on your phone. Say what to start where, from the couch, and your computer plans it and sets it up.**

### Added

- **The Orchestrator on your phone.** **Maestro**, at the top of the phone page's desk, is the desktop's Orchestrator: the same conversation, planned by the same CLI on the computer. Plans come as the same cards, where you can change a step's CLI, workspace, branch or instruction, leave a step out, then **Go** or **Cancel**; **Show me first** / **Just go**, who plans, **New**, and the **Running** list (open a CLI, stop one, or **Stop all** the ones it started) are there too. Tap the mic and speak, or hold it and let go: the phone records, and the computer's own whisper turns it into words, told your workspace names as the desktop's box is. The audio goes over your tailnet to the computer and nowhere else, isn't kept, and the words wait in the box for **Send**. The mic shows when Settings → Voice on the computer has whisper.cpp and a model.

## [2.12.2] - 2026-11-07

**2.12.2: Open in Code from the Orchestrator bar takes you straight to the terminal.**

### Fixed

- **Open in Code from the Orchestrator bar puts the bar away.** Pressing Open in Code on a plan step in the Ctrl+Shift+O bar opened the CLI's terminal underneath the bar, which stayed on top until you closed it, and the first click anywhere else only closed it. The bar now closes as the terminal opens.

## [2.12.1] - 2026-11-07

**2.12.1: talking to the Orchestrator gets your project names right.**

### Fixed

- **Dictating to the Orchestrator hears your workspace names.** Whisper is now told the workspaces' names when you talk in the Orchestrator's box, as it already was for agents and CLIs, so "Star Ledger" or "frontier halls" no longer come out as other words.

## [2.12.0] - 2026-11-07

**2.12.0: talk to VibeForge itself. Say or type what to start where, and one of your own CLIs plans it while VibeForge sets it up.**

### Added

- **The Orchestrator: talk to VibeForge itself.** Say or type what to start, such as "start Claude Code in VibeForge on a new branch called fix-tray and do this, and Grok in Dune to do that", in **Maestro** in the rail or from any view with Ctrl+Shift+O. Hold Ctrl+Shift+Space in its box to dictate. Grok Build turns it into a plan (or Claude Code, Codex or Antigravity CLI, below), in one short turn, using that CLI's own plan: no API key, no local model. VibeForge carries it out: each CLI starts in its own copy of the workspace on the new branch, with its instruction, in a Code pane, and your folder stays where it is.
- **Four planners, and a model for each.** Grok Build, Claude Code, Codex or Antigravity CLI plans, each in a turn that can't change anything (tools off, Codex's read-only sandbox, Antigravity's plan mode). Settings → Orchestrator → **Model** picks what it plans with: its default, one it lists (Grok Build and Antigravity are asked when you open the list; Claude Code's are haiku, sonnet, opus and fable), or one you type. A planner that isn't signed in says so.
- **A plan card before anything starts.** Each step shows its CLI, workspace, branch and instruction; change any of them, drop a step, then press **Go**. **Just go** in Settings starts plans at once, except one with something missing. The Orchestrator can also message a running CLI, close one, or tell you what's running. It answers in text, and never picks a CLI you didn't name.
- **Running, with Stop all.** Beside the conversation, every coding CLI that's open, the Orchestrator's own marked, each with Open in Code and Stop, and Stop all for the ones it started.

## [2.11.0] - 2026-10-29

**2.11.0: a lead hands parts of the work to the agents best suited to them, and you decide whether those tasks wait for you or start on their own.**

### Added

- **A lead for your team.** Pick a **Lead in Code** in Settings → Agents together, such as Claude Code. When a Code pane starts it, it's told your team: the agents allowed in that workspace, what each is good at and what it costs. It hands them parts of the work with `vibeforge task` when another agent is better or cheaper for a part, or when parts can run at the same time, and does the rest itself. Its Claude Code runs `vibeforge` without asking each time.
- **Good at, and cost.** Each agent's Settings tab has a one-line **Good at** and a **Cost** (Cheap, Everyday or Strong) for the lead to choose by. `vibeforge who` lists them too, and only the agents allowed in the asking CLI's workspace.
- **Ask first, or Go ahead.** Under **Ask first**, the default, a task a CLI hands out waits for you: its title bar shows "N to start", to start them or discard them. Under **Go ahead** tasks start at once, up to how many work at the same time and how many a CLI hands out between two of your messages; past those limits they wait for you the same way.
- **The lead can apply its helpers' work** with `vibeforge apply <task>`, if you turn that on. It ends the helper's session and brings its changes into your folder as uncommitted edits. Otherwise you apply them from the task, as before.

### Changed

- **Handed-out tasks wait for you by default.** Since 2.7, `vibeforge task` started a task at once. It now waits for your Start unless Settings → Agents together says Go ahead.

### Fixed

- **A helper stuck on a question says so.** A handed-out task's CLI that stops at a question for a person (Grok Build 1.0.70 asks whether to trust a new folder) used to be reported as finished, with its screen as the answer. The report now says it may be waiting for you and shows the end of its screen, and its real answer follows as a second report once it carries on.
- **A CLI that never moves is still checked.** A task whose CLI showed one screen and never changed it was never looked at again, so its report never came.

## [2.10.0] - 2026-10-28

**2.10.0: CLIs in Code know about each other, and a task you hand out reports back when it's done.**

### Added

- **Handed-out tasks report back.** When an agent finishes its turn on a task another CLI handed it with `vibeforge task`, that CLI gets a report as a message: what the agent said, its changes as a patch with the files listed, and where its copy is. If the task ends before the agent answers, the report says so. The task's terminal shows "Reports to …" until then, and its stop button cancels the report. `--wait` still prints the first answer right away instead.
- **CLIs in Code know about each other.** Claude Code, Codex and Grok Build started in a Code pane are now told about `vibeforge who`, `tell` and `task`, added to their own instructions, so they use them without being shown how. Codex is left alone when its own config sets developer instructions. Turning off Settings → Agents together turns this off too.

### Fixed

- **`vibeforge task` takes the names `vibeforge who` prints.** `who` listed agents by a shortened name, which `task` didn't accept for agents with long names ("No agent called vibeforge-github-repo-ma"). `who` now prints each agent's id, and `task` still takes the shortened names too.
- **Task titles are cut at a word.** A long first line was cut at 80 characters mid-word, so "…containing the single word: hi" became a title without the "hi". It now ends at a whole word with "…".

## [2.9.0] - 2026-10-28

**2.9.0: pick any theme in Settings, and keep it when the desktop switches.**

### Added

- **Pick any theme in Settings.** Settings → Appearance → Colours still follows your Omarchy theme by default, and now lists every theme next to it: the ones installed on your machine, your own included, and Omarchy's 22 stock themes, which VibeForge now ships so they work without Omarchy too. Click one, or move with the arrow keys, and the whole window changes at once. A pinned theme stays when the desktop switches to another; if it is removed, VibeForge goes back to following Omarchy and says so. Ctrl+K finds them too: type "tokyo" and press Enter.

## [2.8.1] - 2026-10-27

**2.8.1: Start at login shows VibeForge in the tray again.**

### Fixed

- **Start at login shows the tray icon.** At login VibeForge could start before Omarchy's bar was ready to take tray icons. It started, hidden as it should be, but with no icon there was nothing to open it from, so it looked as if it hadn't started at all. It now watches for the bar's tray and adds its icon whenever one appears, including after the bar restarts.

## [2.8.0] - 2026-10-27

**2.8.0: the Tokens tab counts OpenCode and Copilot CLI, and Antigravity's tokens show while its session is still open.**

### Added

- **Tokens from OpenCode and Copilot CLI.** The Tokens tab now counts OpenCode, from its `opencode.db` (1.x and 2.x), and Copilot CLI from 1.0.95 on, from the usage record it writes for each model call. A forked session's copies of earlier calls are counted once. Cursor Agent keeps no token counts on disk, and Crush keeps only each session's latest context size, so neither appears.

### Fixed

- **Antigravity's tokens show while its session is still open.** Its conversation databases hold new writes in a side file (`-wal`) until the CLI closes, and the Tokens tab only noticed them after that. It now sees them on the next refresh.

## [2.7.2] - 2026-10-20

**2.7.2: Send to… and review stay in the workspace you meant, a review sees only the changes it was asked about, and answers between CLIs no longer get lost.**

### Fixed

- **Send to… and Review with… never pick a CLI in another workspace unseen.** With one other CLI open somewhere else, the menu went straight to what to send, so "Ask Claude Code to review" pasted the review into a Claude Code in a different workspace (and Send to… jumped there). The menu now lists that CLI with the workspace (or task, chat or routine) it is in, and only skips the choice when the one other CLI is in the same workspace.
- **Review with a new CLI here.** The send menu can start a CLI in a new pane beside this one to do the review, so reviewing doesn't need a second CLI open first.
- **"Its changes" are only its changes.** A review or Send to… → Its changes included every file that was already changed or untracked when the CLI started. Files that were already changed then, and that it hasn't touched since, are now left out; when nothing is left, the review says so and waits for a turn that changes something.
- **Messages to a CLI that has just started** wait until it has drawn its first screen and gone quiet, instead of landing while it is still starting.
- **Handles stay put.** `vibeforge who` names (`claude`, `claude-2`) no longer shift when a CLI closes, so an answer addressed to one can't reach another CLI that started later.
- **An answer isn't lost when the asking CLI stops waiting.** Claude Code's shell tool gives up on a command after two minutes, while `vibeforge tell --wait` waits up to nine. An answer that came after the tool hung up was dropped; it now arrives as a message.
- **The plan meter no longer freezes the window.** Looking for a Gemini (Antigravity) sign-in in the desktop keyring ran on the window's main thread, and a locked or slow keyring held everything up for as long as a second and a half on every plan refresh. It now runs in the background.
- **Writing from the phone or a chat counts as you stepping in**, as typing in the terminal already did: it starts the message count between two CLIs again and lifts a Stop.
- **Stop while a message is going in** no longer drops another message waiting in the queue, a delivery asked for at the end of a pass is no longer put off by a second, and a waited-for answer that never comes stops showing as waiting after half an hour.

## [2.7.1] - 2026-10-20

**2.7.1: clicking a terminal no longer interrupts two CLIs talking, and `vibeforge who` reads like your prompt.**

### Fixed

- **Clicking a terminal no longer counts as typing.** CLIs such as Claude Code ask the terminal to report focus, and those reports reset the message count between two CLIs and lifted a Stop. Focus and mouse reports are now ignored; keys still count.
- **`vibeforge who` shows folders under your home as `~/…`**, as a shell prompt does, instead of the full path.

## [2.7.0] - 2026-10-20

**2.7.0: your CLIs can talk to each other, review each other's changes and hand out tasks.**

### Added

- **Agents together.** A coding CLI in any VibeForge terminal can now talk to the others: `vibeforge who` lists them, `vibeforge tell <name> "…"` pastes a message into another CLI once it is free (labelled with who sent it and how to answer), and `vibeforge tell --wait` brings the answer back, from the session logs of Claude Code, Codex, Grok Build and Kimi Code, or from the screen for other CLIs. An answer that takes longer than the wait arrives later as a message.
- **Hand out tasks.** `vibeforge task <agent> "…"` gives a VibeForge agent a task that runs in its own git copy of the workspace, never in the asking CLI's folder. The task says who asked for it, a person still applies its changes, and a task handed out this way can't hand out more. Agents that VibeForge starts are told about these commands.
- **Send to… and review.** The send button on a Code terminal's title bar puts that CLI's last answer, the selected text or its changes into another CLI's prompt as a draft, and **Ask … to review its changes** has another CLI review the diff when this one's turn ends, then sends the review back.
- **Limits you can see.** Two CLIs can trade 8 messages before the next one waits in the prompt for you to press Enter, and typing in either terminal starts the count again. A chip on the title bar shows who a CLI is talking with, and its stop button ends it. **Settings → Agents together** turns it all off or changes the message limit and the review rounds.
- **Ctrl+K finds what things say.** Typing three letters or more also finds a task by its details, a routine by its prompt and a skill by its procedure, with the words around the match.

### Changed

- **New tasks work in their own copy.** A new task in a git workspace starts with **Work in a separate copy** on, so its agent never edits the folder you or another agent are in. Switch it off on the task to work in the workspace itself; existing tasks keep their setting.
- **Everything in your language.** The tray menu, the quit question, the "still running in the tray" notice, desktop notifications for tasks and routines, plan alerts, schedule descriptions (on your language's clock) and git's change summaries ("2 files +10 −1") now follow VibeForge's language.

### Fixed

- **A routine that can't start says so.** When a scheduled routine fails before its CLI runs (its folder or CLI is gone, or the CLI won't spawn), you now get the same desktop notification as a run that ended, with the reason, and the third failure in a row still says so once.
- **A routine waiting its turn says so.** A due routine that waits for another coding CLI in its folder sends one notification for that slot, naming who it is waiting for.
- **A task or routine on a trust or sign-in question keeps its folder.** Until it has started working, other waiting work doesn't start in the same folder, so nothing lands while the question is still up.
- **Applying a copy with no changes tidies it away.** The copy is removed and the task is marked done, instead of staying until you discard it.

## [2.6.2] - 2026-10-16

**2.6.2: Gemini and Gemini 4 Argon plan limits, and Antigravity CLI token counts.**

### Added

- **Gemini plan limits, including Gemini 4 Argon.** When you are signed in to Antigravity CLI (`agy`) and plan limits are on in Settings → Usage and activity, VibeForge now shows your Gemini 5-hour, 7-day and Gemini 4 Argon windows alongside Claude, Codex, Grok, Kimi and Muse, with the four-point Gemini spark on the desktop and the phone page. The sign-in is read from Antigravity's token file or the system keyring (`gemini` / `antigravity`).
- **Antigravity CLI token counts.** The Tokens tab now reads Antigravity's SQLite conversation databases (`~/.gemini/antigravity-cli/conversations/*.db` and `~/.gemini/antigravity/conversations/*.db`), counting fresh input, cache reads and writes, thinking and output per model (`gemini-4-argon-trial`, `gemini-3.8-flash-n`…) once per model call.

## [2.6.1] - 2026-10-14

**2.6.1: CLIs behind a mise wrapper start again, and the GitHub graph loads.**

### Fixed

- **CLIs installed through mise wrappers run again, and the GitHub graph loads.** Some setups put small scripts in `~/.local/bin` (`gh`, `codex`, `crush`…) that install a CLI through mise on first use and then run `mise x <tool> -- <tool>`. When mise's own folder for that tool is also on PATH, behind `~/.local/bin`, the script finds itself again and loops until something kills it. That is how the login shell's PATH looks, so the GitHub contribution graph timed out with "Command failed: gh api graphql…". VibeForge now runs the program behind such a script when it is on PATH, and uses the script only when nothing else is there. When `gh` does time out, the message says so.

## [2.6.0] - 2026-10-14

**2.6: Antigravity CLI, in place of Gemini CLI.**

### Changed

- **Antigravity CLI replaces Gemini CLI.** On 18 June 2026 Google stopped serving Gemini CLI to free, Google AI Pro and Google AI Ultra accounts. The terminal replacement is Antigravity CLI (`agy`). VibeForge hands it the first prompt with `-i` and reopens the latest session with `--continue`. When the CLI prints `agy --conversation <id>` on the way out, Continue uses that session. An `engines.json` that still has the original Gemini CLI row swaps it for Antigravity in the same place. A Gemini CLI row you edited yourself stays, which covers an API key or a Code Assist Standard or Enterprise license. Pick the model inside Antigravity with `/model` (it remembers). Gemini 4 Argon is offered there on Google AI Ultra and eligible Gemini Enterprise plans, under slugs such as `gemini-4-argon-high`. Token counts still read leftover Gemini CLI chat files. Antigravity does not write a plain token log, so its own usage stays in the CLI's `/usage` panel.

## [2.5.0] - 2026-10-12

**2.5: a desk that fits half a screen, a review you can do with J and K, and editors that save themselves.**

### Added

- **Review a morning's work with J and K.** Runs opens on the first run waiting for review. `J` and `K` step through the list from anywhere in the view, and **Next to review** in the run's header jumps to the next one waiting. Runs you reviewed during the visit stay in the list, so you can go back to them.
- **The diff, right away.** A finished run's Changes tab opens with its saved diff, under a list of the files it touched with the lines added and removed. Click a file to land on it.
- **Settings has a list of its sections.** A list beside the page follows the scroll and jumps to a section, and every section can be found by name in `Ctrl`+`K` ("engines", "sounds", "storage"…).
- **Start a CLI from an empty workspace in one click.** Next to New terminal there is a button for each CLI found on this machine.
- **Ctrl+K opens on what you were just in.** With nothing typed, it lists recent chats, workspaces, agents and open tasks before the views, and offers New chat, New task and New skill.
- **Agents have pixel faces.** Each agent gets a small mirrored pixel face drawn from its name, shaded like the logo, in place of grey initials.
- **What the lights mean.** The shortcuts sheet (`Ctrl`+`Shift`+`/`) now explains the waiting, working and finished marks and the review badges. The rail's tooltips say what each badge counts.

### Changed

- **A half-screen window fits.** On a narrow tile (half a laptop screen on Hyprland), list panels fold to their strip and open over the work area when you need them; picking a row puts them away again. Code's side panel steps aside, and the task board turns into two columns over two rows, instead of the whole view sliding sideways.
- **Editors save themselves.** An agent's Brief, Memory and Settings, and an existing skill, save a moment after you stop typing, and when you leave. `Ctrl`+`S` still saves at once. A quiet line says Saving, Unsaved or Saved.
- **Task and routine sheets lead with the next step.** A task's ember button is what usually comes next: Execute for a task to do, Mark done once it's been reviewed. Run again, Back to To do and Delete moved to the `⋯` menu, and the header shows one status chip. Save and Create sit in a footer that stays in reach.
- **New tasks start ready to run.** A new task picks an agent and a workspace that agent may work in, and choosing another agent moves the workspace to one of its folders.
- **Easier to read.** Faint text is lighter, so small grey text reads on cards and selected rows, and the smallest text size is now 11px.
- **Forms say less.** A long hint keeps its first sentence, with the rest behind a small ⓘ. The "don't put keys here" warning is one quiet line, the chat box shows two key hints, and Claude Code's folder-trust note shows only when Claude Code is picked.
- **Quieter lists.** A run that simply finished no longer carries a green Finished chip; the dot already says so. Chips show for runs that failed, stopped or exited with an error.
- **Shells are numbered.** Two plain shells in one workspace read "Shell 1" and "Shell 2" in their panes and on Home.
- **Home while setting up.** The numbered setup steps no longer repeat as buttons above them, and the 14-day strip waits for the first run.
- **Smaller pieces.** Voice models and voices are picked from a list with one Download button, an engine's command line shows once, and Runs' header gives its Review/Live/All switch the room.

### Fixed

- **Routine times in your language.** "Tomorrow" was always in English, and times used a 24-hour clock in Routines but the language's own clock on Home. Both now use the language's words and clock, and Home's Up next says the day when it isn't today.
- **Reduced motion is honoured everywhere.** With the system's reduced-motion setting on, views, sheets and glides now appear at once, not only the glowing marks.
- **Keycaps on ember buttons** were nearly invisible; they now take the button's text colour.
- **Start at login** said "in the tray" even with the tray off; its hint now says the window opens instead.
- **Task cards** said "running" in English in every language.

## [2.4.0] - 2026-10-10

**2.4: one place to type in a chat.**

### Changed

- **One place to type in a chat.** A running chat used to show the CLI's own prompt and a VibeForge message box under it, with two rows of key hints and a sentence explaining both. Now, while a session runs, its terminal is where you type: dictation and dropped files go straight into it, as in Code. For a longer message, press **Write** in the header (or `Ctrl`+`Shift`+`Enter` in the terminal): a box opens under the terminal, `Enter` sends and closes it, and `Esc` closes it and keeps what you wrote. Agents' chats work the same way.
- **Everything at the top.** The chat's name (click it to rename), its engine, its folder, Write, the mic and Stop now share one header, with a live dot beside the name.
- **Starting and picking up.** A new chat opens on one box in the middle of the pane, with the engine picker inside it. An ended chat dims its last screen behind a box that picks the conversation back up when you send. That replaces the separate Continue session button.
- **Scratch folders named after the chat.** A new chat's folder is named after its first message's first few words (`scratch/airbus-x-ray-a-blueprint`) instead of `scratch/chat-2`. Chats you already have keep their folders.
- **A tidier chat list.** Live chats come first, then Today, Yesterday and earlier days, with short times ("16m") so nothing gets cut off.

## [2.3.1] - 2026-10-09

**2.3.1: Kimi joins the token meter.**

### Fixed

- **Kimi's tokens are counted.** Kimi Code showed in plan limits but never in the Tokens tab. Its session logs (`~/.kimi-code/sessions`, or `$KIMI_CODE_HOME`) are now read like the other CLIs', and its whole history still on this machine is counted the first time, so All time includes it from the start.
- **The usage popover stays whole.** It placed itself once, from its height when it opened, so numbers that arrived a moment later could push it past the bottom of the window, and it scrolled past 60% of the window's height. It now moves as it grows, and may use the window's height.

## [2.3.0] - 2026-10-09

**2.3: tokens by the week, the month and all time.**

### Added

- **Tokens by week, month and all time.** The Tokens tab in the rail's usage popover now switches between today, the last 7 days, the last 30 days and all time, with a total for all your CLIs together. Coding CLIs clear their old logs (Claude Code after 30 days), so VibeForge keeps each day's count in `usage-days.json` in its data folder, and a day stays counted after its logs are gone. All time starts from the oldest log still on this machine the first time it runs. Nothing is sent anywhere.

## [2.2.0] - 2026-10-07

**2.2: copy a run into an issue, see the routine that keeps failing, and a round of fixes from an outside audit.**

### Added

- **Copy as Markdown.** A finished run's ⋯ menu copies it ready for an issue or a pull request: the CLI and agent, the folder, when it ran and how it ended, the prompt, the end of its transcript and its patch (a long patch is cut after a whole file, and says how many more changed).
- **A routine that keeps failing glows.** When a routine's last three runs failed, its card on Routines and its row on Home glow, with a line saying so, until a run succeeds. The notification for the third failure says "failed 3 times in a row", once.

### Fixed

- **A routine that waited its turn runs once.** A routine on a short schedule that waited for another coding CLI past its next slot used to run again as soon as the first run ended. It now counts as the newest slot due when it starts, so one run covers the whole wait.
- **A task's copy only touches its own repository.** Apply, Discard, Execute and Delete check that the repository named in the task file is the workspace's own. If it names another one, Apply refuses, and Discard and Delete remove only VibeForge's own worktree folder, without running git in that other repository.
- **A settings file you were editing is kept.** A JSON file in the config folder that doesn't parse, such as `settings.json` with a hand edit half done, is moved to `settings.json.broken` before VibeForge saves over it. Before, the next change in Settings replaced it.
- **The installer checks for the Node the build needs.** Node 20.19+ or 22.12+, which Vite asks for, instead of any Node 20. An older one used to pass the check and then fail the build.
- **Terminal host problems in your language.** When the terminal host can't start, stops, or keeps stopping, the message is now translated like the rest of the window. It was English in every language.

## [2.1.1] - 2026-10-05

**2.1.1: the words catch up with the app.**

### Fixed

- **Settings → Phone reads like a released feature.** The "not part of this prototype" line is gone, and the buzz is in the opening line. The Tailscale command has its own line with a Copy button, and the card says to use serve rather than funnel. The pairing code stays hidden until you show it, so a screenshot of Settings doesn't give it away, and its hint says that New code signs every phone out. **Open** tries the page on this computer.
- **Text that had fallen behind the app.** Routines say they fire while VibeForge is running, in the tray too, not only while its window is open. Runs' empty page says typed CLIs are recorded too. Muse is named where its token logs and plan limits are read, and in the CLIs the README and website list. Settings → Language says what is still English (the tray menu, some notifications, schedule descriptions) instead of "some other text", the Settings tooltip lists voice and phone, the data folder's description includes task copies, voice models and the log, and the plan panel says how to turn the rest of the plans on.
- **The phone page's first page** says VibeForge has to be running, not open, and that Start sets a new agent or CLI going. Its leftover English copy of its own sentences is gone; the app has served them all since 2.1.0.

## [2.1.0] - 2026-10-05

**2.1: your desk on your phone, plan limits for whoever is signed in, and another branch beside the folder you have.**

**A phone page: check your workspaces and tell a CLI what to do next, from your phone.**

- **Settings → Phone** serves a small page, off until you turn it on and listening on this computer only (`127.0.0.1:4737`). Pair it once with the code in Settings; reach it from your phone through Tailscale Serve (the README has the one command).
- **See what's happening.** Each workspace with the coding CLIs working, waiting or recently finished in it, the plan limits the desktop shows, and a CLI's screen, which opens at its end and follows new output.
- **Start and steer.** Start an agent allowed in a workspace, or any installed CLI on its own, with an optional first prompt. Send the next prompt, pick a finished run back up with your next instruction (a task resumes in its own copy, as its agent), and stop it. A CLI typed into a terminal is interrupted instead, so the terminal stays, and a message never lands in a terminal whose CLI has quit.
- **Buzzes** while the page is open, when a CLI starts waiting or finishes. A buzz on a locked phone is still to come.
- **In your language.** The page speaks the language VibeForge does, errors included.
- **The same look as the desk.** Square corners, JetBrains Mono with Geist headings, flat panels, the pixel plan marks, a slow ember while a CLI is working, and an amber glow when one is waiting. Plan limits start closed; Show in that panel opens them. The same pixel VibeForge as the website sits in the top bar, beside the V mark.
- **A first page.** A paired phone opens on the name, one line, and three buttons: How it works, Settings, and Enter. How it works and Settings each open a panel. Settings holds the switches for buzzes, plan limits, finished work, and larger text. Enter opens the workspaces. Tap VibeForge there to come back. A phone that is not paired still starts on the code.
- **A shorter list.** Each workspace has Show and Hide for its runs. One that is only finished starts hidden, so more workspaces fit on the screen. One that is working or waiting stays open until you hide it.
- **Created by ApexForge**, along the bottom, the same line as the desk and the website.
- **Installs onto the phone.** The first visit on a phone offers to install the page, on the code and the first page only, so the offer never covers a text box. Installed from that offer, it fills the screen.
- **The keyboard.** Tapping a text box shrinks the page to the space above the phone's keyboard. The box and its button stay on screen, and the terminal gives up the room.
- **A follow-up as a CLI leaves a shell.** Send looks at the terminal at that moment, so the second after a CLI quits is not typed into the shell. If the run is still closing, the follow-up waits and then resumes the session. A wrong pairing code during Send, Stop or Start brings the code form back.

**The usage meter follows the plans this computer is signed in to.**

- **Whoever is signed in.** Claude, Codex, Grok, Kimi and Muse each appear when that CLI's own sign-in is on this machine, and stay off the list when it isn't. Signing in to another one shows it on the next refresh, in the desktop usage tab and on the phone page.
- **Muse.** Its 5-hour and weekly windows come from the sign-in check Meta already uses. The extra key in that answer is thrown away and never saved. A plan with nothing used yet in its window shows 0%: Meta leaves the usage out of its answer until there is some, and VibeForge used to call that unreadable and keep showing the last window's numbers. Token totals come from Muse's own session logs, on this machine.
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

[Unreleased]: https://github.com/L0nE-F0x/VibeForge/compare/v2.15.0...HEAD
[2.15.0]: https://github.com/L0nE-F0x/VibeForge/releases/tag/v2.15.0
[2.14.1]: https://github.com/L0nE-F0x/VibeForge/releases/tag/v2.14.1
[2.14.0]: https://github.com/L0nE-F0x/VibeForge/releases/tag/v2.14.0
[2.13.0]: https://github.com/L0nE-F0x/VibeForge/releases/tag/v2.13.0
[2.12.2]: https://github.com/L0nE-F0x/VibeForge/releases/tag/v2.12.2
[2.12.1]: https://github.com/L0nE-F0x/VibeForge/releases/tag/v2.12.1
[2.12.0]: https://github.com/L0nE-F0x/VibeForge/releases/tag/v2.12.0
[2.11.0]: https://github.com/L0nE-F0x/VibeForge/releases/tag/v2.11.0
[2.10.0]: https://github.com/L0nE-F0x/VibeForge/releases/tag/v2.10.0
[2.9.0]: https://github.com/L0nE-F0x/VibeForge/releases/tag/v2.9.0
[2.8.1]: https://github.com/L0nE-F0x/VibeForge/releases/tag/v2.8.1
[2.8.0]: https://github.com/L0nE-F0x/VibeForge/releases/tag/v2.8.0
[2.7.2]: https://github.com/L0nE-F0x/VibeForge/releases/tag/v2.7.2
[2.7.1]: https://github.com/L0nE-F0x/VibeForge/releases/tag/v2.7.1
[2.7.0]: https://github.com/L0nE-F0x/VibeForge/releases/tag/v2.7.0
[2.6.2]: https://github.com/L0nE-F0x/VibeForge/releases/tag/v2.6.2
[2.6.1]: https://github.com/L0nE-F0x/VibeForge/releases/tag/v2.6.1
[2.6.0]: https://github.com/L0nE-F0x/VibeForge/releases/tag/v2.6.0
[2.5.0]: https://github.com/L0nE-F0x/VibeForge/releases/tag/v2.5.0
[2.4.0]: https://github.com/L0nE-F0x/VibeForge/releases/tag/v2.4.0
[2.3.1]: https://github.com/L0nE-F0x/VibeForge/releases/tag/v2.3.1
[2.3.0]: https://github.com/L0nE-F0x/VibeForge/releases/tag/v2.3.0
[2.2.0]: https://github.com/L0nE-F0x/VibeForge/releases/tag/v2.2.0
[2.1.1]: https://github.com/L0nE-F0x/VibeForge/releases/tag/v2.1.1
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
