# To do

Updated for 1.2.0 (2026-09-30): the ember glow, runs by day, a quieter run header, sliding selection, dimmed split panes, loading placeholders and Undo instead of "are you sure?"; see `CHANGELOG.md`. The X post and video for it are in `~/Pictures/VibeForge 1.2/`. Before that, 1.1.0 (2026-09-29): a run keeps its diff, Code links open in the side browser, and two fixes.

## Next up

**Voice** shipped in 0.5.0, and 0.8.0 made it hold-to-talk (see `status.md` and `CHANGELOG.md`). Still to try for real:

- [ ] **Try voice for real** with the microphone, speakers, real Claude Code and a Codex session: hold to dictate, press Enter, and hear the first paragraph.
- [ ] **Talk-back from a CLI typed into a shell**, for real: type `claude` in a Code terminal, dictate a line, press Enter, and check the answer is read aloud (only stand-ins have been through it).
- [ ] **Listen to the 0.8.0 sounds** on real speakers (Settings → Sounds has a play button for each) and say which ones to change.
- [ ] Leave an agent chat thinking, switch to another app, and check the knock, the notification (it should open the chat) and the glow.
- [ ] Ctrl+K from a chat, from Code, and Ctrl+Shift+K from inside a terminal.
- [ ] The tray on the real bar: the icon and its amber corner, pinning it from the tray's arrow, and a real login with Start at login on.

- [ ] **Codex and Gemini usage**, when one of those CLIs is installed here. Run a short session and check the rail popover counts it. Codex's plan limits should show as bars.
- [ ] **Gemini plan limits**, when the next Gemini Pro lands: Gemini CLI's `/stats` quota comes from the Code Assist API (`retrieveUserQuota`, per model, with a project from `loadCodeAssist`). Its Google access token lasts an hour and only Gemini CLI renews it, so read-only would show "sign-in expired" unless Gemini CLI ran recently. Work out the request from Gemini CLI's own source before adding it.
- [ ] **Quota notifications** at 80 / 95 / 100% per window, once per reset, like the Omarchy widget's toasts. Skipped in 0.7.0 so the two don't both fire; would need its own switch.
- [ ] **Token usage from more CLIs**: Kimi's session logs weren't read (its plan limits are in 0.7.0), and OpenCode (SQLite now), Copilot, Cursor Agent and Crush weren't looked at.
- [ ] **Translate the rest of the UI.** The forms in Agents, Tasks, Routines and Skills, the engine editor, run details, Home, toast messages, and the errors the main process sends (`src/core/team-service.ts`) are still English. Relative times ("5m ago", `src/shared/text.ts`) should use `Intl.RelativeTimeFormat` in the chosen language. Add each key to `src/ui/i18n/en.ts` first; the typecheck then lists every language that needs it.
- [ ] **Release notes on each tag.** `gh release create vX.Y.Z --notes-file …` after bumping `package.json`; the in-app Update shows those notes.

## Parked

- [ ] **A phone companion** (on the roadmap): a PWA served by VibeForge over Tailscale only, off by default, to see who's waiting, the runs inbox and plan limits (then maybe reply, Continue or Stop). Parked 2026-09-29 while the founder reads up on Tailscale. Open questions: Tailscale or not, a desktop that stays on or a laptop that suspends, and see-only or drive.
- [ ] **An AUR package**, so Omarchy users can update with `yay`. Parked because the AUR has closed new account registration for now (2026-09-25); watch aur-general or the Arch news feed for it to reopen. The package would set `VIBEFORGE_UPDATE_COMMAND` (or be detected as an "other" install) so the in-app Update points to the package manager.

## Known rough edges

- Restart after an update relaunches with the same arguments and environment; worth a real click on an installer copy after the next release.
- `npm audit` (2026-09-28, on Electron 44): only Vitest's advisory, which is dev-only (fixing it is a major bump, not urgent).
