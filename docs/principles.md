# Principles

What VibeForge does and won't do. A change that breaks one of these needs a reason in its pull request, and a decision from the maintainer.

## It runs the CLIs you already sign in to

VibeForge never calls a model API and never holds an API key. Every engine is a coding CLI on your `PATH` that you signed in to yourself; VibeForge starts it in a real terminal and gives it a home. If a CLI isn't signed in, its terminal shows the CLI's own sign-in. Maestro plans with one of those CLIs, on that CLI's own subscription, in a turn that can't change anything.

Plan limits, when you turn them on, read the sign-in a CLI saved on this machine to ask its provider for your usage. VibeForge never renews, rewrites or keeps that sign-in, and saves only the percentages.

## No telemetry

VibeForge sends no analytics, crash reports or usage data anywhere. Its own log (`~/.local/share/vibeforge/logs/vibeforge.log`) stays on this machine and never holds prompts or terminal output. **Help → Copy diagnostics** and the bug report form are things you send yourself, after reading them.

## Your files are plain text

Agents, briefs, memory, skills, routines and tasks are YAML and Markdown under `~/.config/vibeforge`; engines, settings and workspaces are JSON beside them. Edit them in any editor and VibeForge picks up the change. Each run is a folder under `~/.local/share/vibeforge/runs` holding its prompt, transcript, final screen and diff (the long files gzipped once it ends).

## Networked features are opt-in

Anything that goes over the network stays off until you turn it on:

- **Plan limits** (Settings → Usage and activity) ask Anthropic, xAI, Google, Moonshot, OpenAI and Meta, at most every 3 minutes.
- **The GitHub graph** (Settings → Usage and activity → GitHub) asks GitHub through your `gh`, at most every 30 minutes, and keeps no token.
- **The phone page** (Settings → Phone) listens on `127.0.0.1:4737` only, behind a pairing code; Tailscale Serve is how a phone reaches it.
- Whisper models and Piper voices download from Hugging Face only when you press Download.

**The update check is the one networked call that is on by default** (`checkUpdates` in `src/core/store.ts`). Twenty seconds after start and every six hours, VibeForge asks GitHub's release API for the newest release number. The request carries nothing but your IP address and `VibeForge/<version>` as its user agent. Turn it off in **Settings → Updates** (or set `"checkUpdates": false` in `settings.json`); **Check now** still works.

## A person decides each step

- Writing or assigning a task starts nothing. **Execute** does.
- Maestro shows a plan as a card that waits for **Go**. **Just go** is a setting you choose.
- Dictated words land in the box or terminal and wait for you to press Enter.
- Work done in a task's or Maestro's own copy comes back only when you press **Apply**, as uncommitted edits you can read before you commit.
- A task one CLI hands another waits for you under **Ask first**, the default. Two CLIs can trade 8 messages before the next one waits in the prompt for you.

## Undo instead of "are you sure?"

Deleting an agent, chat, task, skill or routine, or discarding a copy, happens at once, with **Undo** on the toast and <kbd>Ctrl</kbd>+<kbd>Z</kbd>. VibeForge asks first only when something still running would be stopped, or work would be lost for good. A task that finds its folder busy waits its turn and starts on its own, instead of refusing.

## One engine per agent

An agent has one engine. VibeForge doesn't route work between models, pick a cheaper one, or fall back to another when a CLI fails or hits its limit. Maestro never starts a CLI you didn't name, and a lead CLI that hands out tasks decides that itself. Forks that want routing are welcome.

## Voice stays on this machine

[whisper.cpp](https://github.com/ggml-org/whisper.cpp) turns speech into text and [Piper](https://github.com/OHF-Voice/piper1-gpl) reads answers aloud, both locally. No audio is sent to a service or kept. The phone's mic records on the phone and sends the audio over your tailnet to this computer's whisper, and nowhere else.

## Honest limits

Allowed folders are a policy, not a sandbox: runs start inside them and the prompt tells the CLI to stay there, but a coding CLI has a shell. VibeForge is built for Omarchy (Arch + Hyprland) and has no Windows or macOS builds.
