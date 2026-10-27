# To do

What's next. What shipped is in `CHANGELOG.md` (2.8.0, 2026-10-27, is the latest release), and what has been verified, and how, is in `status.md`.

## Next up

Nothing queued.

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
- **No tokens from Cursor Agent or Crush** (looked at 2026-10-26, see `status.md`). Cursor Agent only gets its counts from Cursor's server and hands them to hooks; Crush overwrites each session's count with the latest context size. Revisit if either starts keeping a per-call log.
