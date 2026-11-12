# Status

**2.16.0**, released 2026-11-12. What shipped is in [CHANGELOG.md](../CHANGELOG.md), what's next in [todo.md](todo.md), and the engineering log up to 2.13.0 in [archive/status-log.md](archive/status-log.md).

Every change runs `npm test` (665 tests at 2.16.0, including the real PTY host driven with `/bin/bash`) on Node 22, 24 and 26, the typecheck (the TypeScript, and the terminal host, `vibeforge tell` and the phone page through JSDoc), lint, an audit of what ships, the coverage floors (85% on `src/core` and `src/shared`, and one per file), and `scripts/smoke.mjs` on the built app. CI runs all of them on each pull request and on `main`, the smoke test under `xvfb-run`, and also packs the ready-made build, installs it into a scratch home and runs the smoke test from there; the Release workflow publishes a tag only once those checks passed on its commit on `main` (since 2.16.0 in two jobs: a build with a read-only token, then a publish that attests the build), and has published every tag from 1.3.0 to 2.15.0. Features are then driven in the built app over CDP with a scratch profile.

## What has been checked

"For real" means real CLIs, real services or the real desktop. The rest ran against stand-in CLIs, synthetic audio and a hidden test window.

| Area | For real | Only with stand-ins or tests |
| --- | --- | --- |
| Chats and Continue | Claude Code: the first prompt, a pasted follow-up, Continue with its own `--resume` id | |
| Code terminals | Claude Code and Grok measured working and quiet; Claude Code's trust question flagged as waiting; Claude Code and Muse sessions recorded as runs in daily use | Talk-back from a CLI typed into a terminal |
| Tasks and copies | Claude Code waiting its turn, working in its own copy, Apply with and without a conflict | A copy of a repository Claude Code hasn't trusted yet |
| Agents together | Claude Code asking Grok Build with `tell --wait`; a lead Claude Code handing Grok Build a task under Ask first, and the report coming back | |
| Maestro | Plans from Grok Build, Claude Code and Antigravity CLI, carried out with stand-in CLIs | Codex as the planner (not signed in on this machine); 2.16's new workspace, model and effort, open in place, apply/discard/show steps and the notes when a CLI finishes, driven in the built app with a stand-in planner and CLIs |
| Other CLIs | | A first prompt to Codex, Cursor Agent, OpenCode, Copilot, Crush, Pi and Hermes (their rows follow each CLI's `--help`) |
| Plan limits | Claude, Grok, Kimi and Gemini against their services; Muse's sign-in unchanged by a refresh | Codex's windows (read from its logs); the day's line over a long day; an expired sign-in in the popover; alerts at 80, 95 and 100% |
| Token counts | This machine's Claude Code, Grok Build, Kimi Code, Muse and Antigravity CLI logs; OpenCode 2.0.32's own database | Codex and Gemini CLI (no sessions here), Copilot CLI (read from its schema) |
| Voice | The real whisper.cpp and Piper, with Piper-spoken audio as the microphone; Super+Alt+V by hand on the desktop | A real microphone and speakers |
| Desktop | The tray in the bar and its menu, a notification opening its chat, an image pasted into Claude Code, fcitx5 in a terminal (by hand, 2026-09-28); Start at login at a real login, which found the missing icon fixed in 2.8.1 | The 2.8.1 fix at a real login; the tray's amber corner and pinning; Super+C copying; sounds on real speakers; the browser dock's still image seen by eye |
| Phone page | Headless Chrome at phone size on loopback, with the real whisper hearing Maestro's mic | A real phone over Tailscale Serve, its mic on iOS Safari, the installed page |
| Routines and upkeep | | A routine firing at a real cron time; Settings → Storage's first upkeep on a large run folder |
| Updates | The installer finding the latest release on GitHub | The in-app check and Update (a stand-in release server and command); 2.16's Update through the release's own install.sh and its digest, and the two-job release workflow (its first real run is the 2.16.0 tag); Restart after a real update; Copy diagnostics read back from the clipboard |

## Known limits

- Claude Code asks you to trust each new folder once, so a new chat's first message waits for that answer in its terminal.
- Allowed folders are a policy in the prompt, not a sandbox.
- No token counts from Cursor Agent or Crush: neither keeps per-call counts that can be added up.
- Turning the tray off applies from the next start. Electron names every tray item `chrome_status_icon_1`, so a pin can also catch another Electron app's icon.
- Which terminal handed out which task lives in memory: after a restart a lead CLI can't `vibeforge apply` tasks it handed out before (Apply on the task still works). Tasks and routines waiting for their folder are kept in `waiting.json` and survive a restart.
- Maestro's checkouts made before 2.14 (`<project>.worktrees/<branch>`) get no Apply or Discard; remove them by hand.
- The phone page buzzes only while it is open; a locked phone would need Web Push.

## Risks

- **The CLIs change under VibeForge.** Prompt flags, session-log formats (talk-back, `--wait`, token counts) and the plan-limit endpoints (Claude's OAuth usage, Grok's billing, Kimi's usages) aren't stable public APIs. Grok Build updated itself mid-trial in 2.11 and added a trust question. The model and effort options Maestro passes (2.16) were read from each CLI's `--help` on 2026-11-12.
- **Plan limits use the CLIs' saved sign-ins.** They're only read, never renewed, but a provider could object. That is one reason the feature is off by default.
- **Dependencies.** `npm audit` on 2026-11-12: no advisories, with or without dev tools, on Electron 45, Vite 8, Vitest 5 and TypeScript 7. CI fails on a high-severity advisory in what ships, and Dependabot proposes updates weekly. Electron 45's tray, voice and notifications were checked only through the headless smoke and stand-in drives, not on the real bar.
- **The control socket trusts the terminal a caller names.** A CLI can claim another pane's `VIBEFORGE_PTY`; a per-terminal token in the environment wouldn't stop that, because processes of the same user can read each other's environment.
- **One machine.** Everything above was checked on the founder's Omarchy desktop; other Arch + Hyprland setups are untested.
