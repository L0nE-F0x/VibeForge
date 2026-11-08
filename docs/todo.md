# To do

What's next. What shipped is in `CHANGELOG.md` (2.13.0, 2026-11-07, is the latest release), and what has been verified, and how, is in `status.md`.

## Next up

- [ ] **Muse as a planner**, later (founder, 2026-11-07).
- [ ] **Maybe later:** the desktop voice key (Super+Alt+V) straight to Maestro, and a per-workspace strip in Code (the Running list in Maestro covers Stop all for now).

## Only checked with stand-ins

These work against fake CLIs, synthetic audio and the hidden test window. Nothing is known to be wrong:

- Dictation and talk-back with a real microphone and speakers, including talk-back from a CLI typed into a Code terminal.
- The 0.8.0 sounds on real speakers.
- The tray's amber corner and pinning it from the tray's arrow, on the real bar. (The tray and its menu were checked by hand on 2026-09-28.)
- The 2.8.1 Start at login fix across a real login. A real login found the missing icon; the fix was checked against a stand-in tray host.
- Settings → Storage's first upkeep on a large real run folder.
- A task in its own copy on a repository Claude Code hasn't trusted yet.
- **Codex as Maestro's planner.** Built to Codex's JSON lines and tested against its real "not signed in" answer. Codex isn't signed in on this machine, so a real plan from it waits for someone who uses Codex.

## Parked

- [ ] **A buzz when the phone is locked.** The page already buzzes while it is open. A locked phone needs Web Push, which goes through Apple's or Google's push servers: the first third-party service VibeForge would use. Parked on 2026-10-20; if it comes back, it is opt-in and the push carries no content.

- [ ] **An AUR package**, so Omarchy users can update with `yay`. Parked because the AUR has closed new account registration for now (2026-09-25); watch aur-general or the Arch news feed for it to reopen. The package would set `VIBEFORGE_UPDATE_COMMAND` (or be detected as an "other" install) so the in-app Update points to the package manager.

## Known rough edges

- `npm audit` (2026-11-08): 11 advisories. Electron 44.4.5 is the one that reaches users, since the app runs on it: two advisories, fixed in 44.9.1, which `npm audit fix` picks up. Vite, undici and source-map-js are build tools with fixes in range; Vitest's (and the coverage packages under it) need Vitest 5, a major bump. `npm audit --omit=dev` finds nothing because Electron is a dev dependency.
- **No tokens from Cursor Agent or Crush** (looked at 2026-10-26, see `archive/status-log.md`). Cursor Agent only gets its counts from Cursor's server and hands them to hooks; Crush overwrites each session's count with the latest context size. Revisit if either starts keeping a per-call log.
