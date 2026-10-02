# To do

2.0.0 (2026-10-01): agents take turns in a folder, every waiter has a name on Home and in the tray, Hand off, and task copies that can only ever delete themselves (1.3.1); see `CHANGELOG.md` and `status.md`. Updated for 1.3.0 (2026-09-30): the Code mic as a click, task copies (git worktrees), run search, run storage and Settings → Storage, plan alerts, the rest of the UI translated, keyboard focus, a quieter log, the service split up, a CI smoke test and releases from tags; see `CHANGELOG.md` and `status.md`. Updated for 1.2.0 (2026-09-30): the ember glow, runs by day, a quieter run header, sliding selection, dimmed split panes, loading placeholders and Undo instead of "are you sure?"; see `CHANGELOG.md`. The X post and video for it are in `~/Pictures/VibeForge 1.2/`. Before that, 1.1.0 (2026-09-29): a run keeps its diff, Code links open in the side browser, and two fixes.

## Next up

**Try for real** (from the 2026-09-30 pass; everything else was checked on the hidden test window):

- [ ] **The Code mic with your microphone, leaning back**: click it, talk, click again, press Enter. Then the same in a chat box.
- [x] **A real task in its own copy**, with Claude Code (2026-10-01, headless): no trust question for a worktree of a trusted repository; Apply and a conflict both worked. Still worth one try on a repository Claude hasn't trusted yet.
- [ ] **Settings → Storage on your real runs**: the first upkeep, 2 minutes after start, compresses them (86 MB → about 15 MB expected). Pick a keep rule only if you want old runs gone.
- [ ] **The CI smoke job** on the first push (xvfb on GitHub's runner). If it's reliable, consider making it a required check.

**Voice** shipped in 0.5.0, and 0.8.0 made it hold-to-talk (see `status.md` and `CHANGELOG.md`). Still to try for real:

- [ ] **Try voice for real** with the microphone, speakers, real Claude Code and a Codex session: hold to dictate, press Enter, and hear the first paragraph.
- [ ] **Talk-back from a CLI typed into a shell**, for real: type `claude` in a Code terminal, dictate a line, press Enter, and check the answer is read aloud (only stand-ins have been through it).
- [ ] **Listen to the 0.8.0 sounds** on real speakers (Settings → Sounds has a play button for each) and say which ones to change.
- [ ] Leave an agent chat thinking, switch to another app, and check the knock, the notification (it should open the chat) and the glow.
- [x] Ctrl+K from a chat, from Code, and Ctrl+Shift+K from inside a terminal (2026-09-30, CDP keys on the hidden window).
- [ ] The tray on the real bar: the icon and its amber corner, pinning it from the tray's arrow, and a real login with Start at login on.

- [ ] **Codex and Gemini usage**, when one of those CLIs is installed here. Run a short session and check the rail popover counts it. Codex's plan limits should show as bars.
- [ ] **Gemini plan limits**, when the next Gemini Pro lands: Gemini CLI's `/stats` quota comes from the Code Assist API (`retrieveUserQuota`, per model, with a project from `loadCodeAssist`). Its Google access token lasts an hour and only Gemini CLI renews it, so read-only would show "sign-in expired" unless Gemini CLI ran recently. Work out the request from Gemini CLI's own source before adding it.
- [x] **Quota notifications** at 80 / 95 / 100% per window, once per reset, behind their own switch (off by default).
- [ ] **Token usage from more CLIs**: Kimi's session logs weren't read (its plan limits are in 0.7.0), and OpenCode (SQLite now), Copilot, Cursor Agent and Crush weren't looked at.
- [x] **Translate the rest of the UI.** Done for the window and the main process's messages (`src/ui/core-text.ts`). Still English: the tray menu, native dialogs, desktop notifications, cronstrue's schedule descriptions and git's change summaries.
- [x] **Release notes on each tag.** Pushing `vX.Y.Z` runs `.github/workflows/release.yml`, which publishes the CHANGELOG section (`scripts/release-notes.mjs`). Watch the first one go through.

## Parked

- [ ] **A phone companion** (prototype, 2026-10-03): Settings → Phone serves a page on 127.0.0.1 only, off by default. The page lists workspaces, shows the screen, starts an agent that is allowed in that folder or any CLI on its own, sends the next prompt (picking a finished session back up when needed), and stops or interrupts it. The computer stays on. Tailscale Serve (`tailscale serve --bg --https=443 http://127.0.0.1:4737`) is how a phone reaches it. A buzz works while the page is open. A buzz on a locked phone is still to build. Plan limits are not on the page.
- [ ] **An AUR package**, so Omarchy users can update with `yay`. Parked because the AUR has closed new account registration for now (2026-09-25); watch aur-general or the Arch news feed for it to reopen. The package would set `VIBEFORGE_UPDATE_COMMAND` (or be detected as an "other" install) so the in-app Update points to the package manager.

## Known rough edges

- Restart after an update relaunches with the same arguments and environment; worth a real click on an installer copy after the next release.
- `npm audit` (2026-09-28, on Electron 44): only Vitest's advisory, which is dev-only (fixing it is a major bump, not urgent).
