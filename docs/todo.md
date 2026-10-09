# To do

What's next. What shipped is in `CHANGELOG.md` (2.3.0, 2026-10-09, is the latest release), and what has been verified, and how, is in `status.md`.

## Next up

- [ ] **A buzz when the phone is locked.** The page already buzzes while it is open. A buzz on a locked phone is still to build.
- [ ] **The last English in other languages.** The tray menu, the quit question, the "still running in the tray" notice and the core's run-finished notifications are still in English, and so are cronstrue's schedule descriptions and git's change summaries. The window and the phone page are translated.
- [ ] **Gemini plan limits**, when the next Gemini Pro lands. Gemini CLI's `/stats` quota comes from the Code Assist API (`retrieveUserQuota`, per model, with a project from `loadCodeAssist`). Its Google access token lasts an hour and only Gemini CLI renews it, so a read-only approach would show "sign-in expired" unless Gemini CLI ran recently. Work out the request from Gemini CLI's own source before adding it.
- [ ] **Token usage from more CLIs.** Kimi's session logs aren't read yet (its plan limits are), and OpenCode (SQLite now), Copilot, Cursor Agent and Crush haven't been looked at.

## Only checked with stand-ins

These work against fake CLIs, synthetic audio and the hidden test window. Nothing is known to be wrong:

- Dictation and talk-back with a real microphone and speakers, including talk-back from a CLI typed into a Code terminal.
- The 0.8.0 sounds on real speakers.
- The tray on the real bar: the amber corner, pinning it from the tray's arrow, and Start at login across a real login.
- Settings → Storage's first upkeep on a large real run folder.
- A task in its own copy on a repository Claude Code hasn't trusted yet.

## Parked

- [ ] **An AUR package**, so Omarchy users can update with `yay`. Parked because the AUR has closed new account registration for now (2026-09-25); watch aur-general or the Arch news feed for it to reopen. The package would set `VIBEFORGE_UPDATE_COMMAND` (or be detected as an "other" install) so the in-app Update points to the package manager.

## Known rough edges

- A routine whose third failure in a row is a failed *start* (folder or CLI gone) glows, but gets no notification: failed starts don't send a finish notification.

- `npm audit` (2026-09-28, on Electron 44): only Vitest's advisory, which is dev-only (fixing it is a major bump, not urgent).
