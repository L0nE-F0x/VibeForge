<p align="center">
  <img src="resources/icon.svg" width="96" height="96" alt="VibeForge">
</p>

<h1 align="center">VibeForge</h1>

<p align="center">
  <strong>Your coding agents, forged into one desk.</strong><br>
  An open-source desktop for <a href="https://omarchy.org">Omarchy</a> that runs Claude Code, Codex, Grok and every other coding CLI you already use — in real terminals, as a team.
</p>

<p align="center">
  <a href="https://vibe-forge.net"><strong>vibe-forge.net</strong></a>
</p>

<p align="center">
  <a href="LICENSE"><img alt="MIT license" src="https://img.shields.io/badge/license-MIT-ff6b35?style=flat-square"></a>
  <img alt="Linux only" src="https://img.shields.io/badge/platform-Omarchy%20%C2%B7%20Arch%20%C2%B7%20Hyprland-fca311?style=flat-square">
  <img alt="No telemetry" src="https://img.shields.io/badge/telemetry-none-34d399?style=flat-square">
</p>

---

VibeForge never calls a model API and never holds a key. Every engine is a CLI you are already signed in to; VibeForge gives them a home. It remembers **who** does the work (agents with a brief, memory and skills), **where** they may work (allowed folders), **when** work starts (routines), and **what to review** when it ends (every run keeps its final screen, a transcript and the git diff since it began). No accounts. No telemetry. Everything on disk is plain YAML and Markdown.

## Install

On Omarchy (or any Arch + Hyprland setup):

```bash
curl -fsSL https://vibe-forge.net/install | bash
```

Then open **VibeForge** from the app launcher (<kbd>Super</kbd> + <kbd>Space</kbd>) or run `vibeforge`. Add `--uninstall` to remove the launcher (your data stays).

The installer needs `git`, Node 20+ (Omarchy ships mise: `mise use -g node@lts`) and `base-devel` + `python` to build the terminal engine. It clones into `~/.local/share/vibeforge-app`, checks out the newest [release](https://github.com/L0nE-F0x/VibeForge/releases), and adds `~/.local/bin/vibeforge` and a desktop entry. Set `VIBEFORGE_BRANCH=main` to follow the main branch instead.

**Updating.** VibeForge asks GitHub for the newest release number when it starts and every six hours (nothing else is sent; turn it off in Settings → Updates). When one is out, Help in the rail gets a dot: **Update** shows the release notes, runs the installer in a terminal you can watch, then restarts. Running the install command again does the same.

<details>
<summary>Build it yourself</summary>

```bash
git clone https://github.com/L0nE-F0x/VibeForge.git
cd VibeForge
npm install
npm start           # development: Vite + Electron with hot reload
npm run build       # production build
./scripts/vibeforge # run the build
```

</details>

## What's inside

| View | What it is for |
| --- | --- |
| **Home** | What's live, what finished and needs review, what fires next. |
| **Agents** | Named teammates with a brief, memory, skills and allowed folders. Chats with an agent are real terminals. Switch its engine from Claude to Codex to Grok and the teammate stays the same. |
| **Code** | A workspace with tiled terminals (shells and CLIs side by side) that you can split, drag to rearrange and maximize, a file tree that inserts paths, and a browser dock for your dev server. Layouts are remembered per workspace. |
| **Chat** | Throwaway conversations in an empty scratch folder. |
| **Tasks** | A board. Writing or assigning a task starts nothing; **Execute** does. A finished run lands in Review with its diff. |
| **Routines** | Cron or interval schedules that open a fresh agent run while VibeForge is open. Missed slots are shown, never replayed. |
| **Skills** | Reusable `SKILL.md` procedures you install on agents. |
| **Runs** | Every process VibeForge started: final screen, transcript, prompt, and the diff since it began. **Continue** reopens the exact session. |

It wears your Omarchy theme: colours come from the active theme (`colors.toml` plus the ghostty palette for terminals) and change live when you switch themes.

It speaks English, Deutsch, Español, Français, Português (Brasil), 日本語 and 简体中文, following your system language unless you pick one in Settings. The tour, menus, tooltips and empty screens are translated so far; some other text is still English. Translations live in `src/ui/i18n/`, one file per language, and the typecheck fails if one is missing a line.

## Works with

Anything with a command line. The defaults know how to hand a first prompt to **Claude Code**, **Codex**, **Grok**, **Cursor Agent**, **Gemini CLI** and **OpenCode** as an argument, and paste it into **Copilot**, **Kimi**, **Crush**, **Pi**, **Hermes** or any other CLI once it's ready. Add your own in Settings or in `~/.config/vibeforge/engines.json`:

```json
{ "id": "claude", "label": "Claude Code", "bin": "claude", "args": [],
  "promptArgs": ["{prompt}"], "continueArgs": ["--continue"] }
```

`args` are always passed. `promptArgs` puts the first message on the command line (`{prompt}` is replaced); leave it out and VibeForge pastes the message once the CLI is ready. `continueArgs` reopens the CLI's latest session in a folder — and when a CLI prints its own resume line on exit (`claude --resume <id>`, `grok --resume <id>`, `codex resume <id>`), **Continue** uses that exact session instead.

## How it works

```
React UI ──IPC──▶ Electron main ──JSON lines──▶ PTY host (system Node)
                  agents, chats, tasks,          node-pty + a headless xterm per
                  routines, runs, scheduler      terminal → your CLIs
```

- **The PTY host** owns every terminal. It mirrors each screen in a headless xterm, so a view that reattaches redraws exactly; it pastes prompts only once a CLI has gone quiet; and when a run ends it writes the final screen, a plain-text transcript and a capped raw scrollback. Stopping hangs up the process group (SIGHUP → SIGTERM → SIGKILL), like closing a terminal window.
- **One writer for run state**: `meta.json` in each run folder plus a SQLite index, with change events pushed to the UI.
- **Login-shell PATH**: VibeForge asks your login shell for `PATH` at start, so CLIs installed with mise or into `~/.local/bin` are found however it was launched.
- **Allowed folders are a policy, not a sandbox.** Runs start inside them and the prompt tells the CLI to stay there, but a coding CLI has a shell.

## Your files

```
~/.config/vibeforge/            edit anywhere — VibeForge picks up changes live
  agents/<id>/agent.yaml        name, engine, brief, allowed folders, skills
  agents/<id>/memory.md         durable notes added to every run
  skills/<id>/SKILL.md
  routines/<id>.yaml
  tasks/<id>.yaml
  engines.json  settings.json  workspaces.json  layouts/
~/.local/share/vibeforge/
  runs/<stamp>_<slug>/          meta.json, preamble.md, terminal.ansi, transcript.txt, scrollback.txt, git.txt
  scratch/<chat>/               Chat mode working folders
```

Override the roots with `VIBEFORGE_CONFIG` and `VIBEFORGE_DATA`. VibeForge's own log is `~/.local/share/vibeforge/logs/vibeforge.log`: what the app did and what went wrong, never prompts or terminal output. **Help → Copy diagnostics** puts your versions, a few settings and its last 200 lines on the clipboard for a bug report.

## Keys

<kbd>Ctrl</kbd>+<kbd>1</kbd>…<kbd>8</kbd> views · <kbd>Ctrl</kbd>+<kbd>,</kbd> settings · <kbd>Alt</kbd>+<kbd>←</kbd> back · <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>B</kbd> collapse the side panel · <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>M</kbd> maximize the focused pane · <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>/</kbd> every shortcut · <kbd>Ctrl</kbd>+<kbd>S</kbd> save · <kbd>Esc</kbd> close · in terminals <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>C</kbd>/<kbd>V</kbd> copy and paste (plain <kbd>Ctrl</kbd>+<kbd>V</kbd> reaches the program, as in a native terminal) · drop files on a terminal to insert their paths.

In Code, drag a pane by its title bar onto another pane: the middle swaps them, an edge docks it on that side. Double-click a title bar to maximize. Side panels resize from their edge and collapse to a strip. **Help** in the rail replays the welcome tour, checks for updates, copies diagnostics, and opens bug reports and feature ideas as GitHub issues with your versions filled in; nothing is sent from the app.

## Develop

```bash
npm test            # unit tests + the real PTY host driven with /bin/bash (never a model CLI)
npm run typecheck
```

The code is in `src/core` (the service, storage, scheduler — plain Node), `src/ui` (React) and `electron/` (main process, preload, PTY host). The website is plain HTML/CSS/JS in `site/` and deploys to Netlify from `netlify.toml` with no build step; preview it with `python3 -m http.server -d site`. `docs/original-brief.md` is the product brief VibeForge grew from; `docs/status.md` says what has been verified.

---

VibeForge is an independent project. It is not affiliated with Omarchy, Anthropic, OpenAI, xAI, Google, GitHub or any CLI it runs; their names are used only to say what VibeForge works with. Released under the [MIT license](LICENSE).
