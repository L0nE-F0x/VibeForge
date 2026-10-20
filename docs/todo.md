# To do

What's next. What shipped is in `CHANGELOG.md` (2.7.1, 2026-10-20, is the latest release), and what has been verified, and how, is in `status.md`.

## Next up

- [ ] **Token usage from more CLIs.** OpenCode (SQLite now), Copilot, Cursor Agent and Crush haven't been looked at. Leftover Gemini CLI chat files are still counted alongside Antigravity's conversation databases.

## Only checked with stand-ins

These work against fake CLIs, synthetic audio and the hidden test window. Nothing is known to be wrong:

- Dictation and talk-back with a real microphone and speakers, including talk-back from a CLI typed into a Code terminal.
- The 0.8.0 sounds on real speakers.
- The tray on the real bar: the amber corner, pinning it from the tray's arrow, and Start at login across a real login.
- Settings → Storage's first upkeep on a large real run folder.
- A task in its own copy on a repository Claude Code hasn't trusted yet.

## Parked

- [ ] **A buzz when the phone is locked.** The page already buzzes while it is open. A locked phone needs Web Push, which goes through Apple's or Google's push servers: the first third-party service VibeForge would use. Parked on 2026-10-20; if it comes back, it is opt-in and the push carries no content.

- [ ] **An AUR package**, so Omarchy users can update with `yay`. Parked because the AUR has closed new account registration for now (2026-09-25); watch aur-general or the Arch news feed for it to reopen. The package would set `VIBEFORGE_UPDATE_COMMAND` (or be detected as an "other" install) so the in-app Update points to the package manager.

## Known rough edges

- `npm audit` (2026-09-28, on Electron 44): only Vitest's advisory, which is dev-only (fixing it is a major bump, not urgent).
