# To do

What's next. What shipped is in `CHANGELOG.md` (2.17.0, 2026-11-14, is the latest release), and what has been verified, and how, is in `status.md`.

## Next up

- [ ] **Muse as a planner**, later (founder, 2026-11-07).
- [ ] **Maybe later:** the desktop voice key (Super+Alt+V) straight to Viby, and a per-workspace strip in Code (the Running list in Viby covers Stop all for now).

## Only checked with stand-ins

These work against fake CLIs, synthetic audio and the hidden test window. Nothing is known to be wrong:

- Dictation and talk-back with a real microphone and speakers, including talk-back from a CLI typed into a Code terminal.
- The 0.8.0 sounds on real speakers.
- The tray's amber corner and pinning it from the tray's arrow, on the real bar. (The tray and its menu were checked by hand on 2026-09-28.)
- The 2.8.1 Start at login fix across a real login. A real login found the missing icon; the fix was checked against a stand-in tray host.
- Settings → Storage's first upkeep on a large real run folder.
- A task in its own copy on a repository Claude Code hasn't trusted yet.
- **Codex as Viby's planner.** Built to Codex's JSON lines and tested against its real "not signed in" answer. Codex isn't signed in on this machine, so a real plan from it waits for someone who uses Codex.

## Left from recent audits

- [ ] **Viby: a "waiting for you" note.** The core can't tell a CLI waiting for a person from one that's quiet; only the window works that out. Moving that into the core would let Viby say so too.
- [ ] **Neighbouring panes keep their place.** A split or a close remounts the terminal beside it (its scrollback comes back, its scroll position and selection don't). Needs a keyed pane tree in SplitView.
- [ ] **File names that aren't UTF-8** still go through UTF-8 text when Apply lists what changed. Rare; their content is now carried byte for byte.

## Parked

- [ ] **A buzz when the phone is locked.** The page already buzzes while it is open. A locked phone needs Web Push, which goes through Apple's or Google's push servers: the first third-party service VibeForge would use. Parked on 2026-10-20; if it comes back, it is opt-in and the push carries no content.

- [ ] **An AUR package**, so Omarchy users can update with `yay`. Parked because the AUR has closed new account registration for now (2026-09-25); watch aur-general or the Arch news feed for it to reopen. The package would set `VIBEFORGE_UPDATE_COMMAND` (or be detected as an "other" install) so the in-app Update points to the package manager.

## Known rough edges

- **No tokens from Cursor Agent or Crush** (looked at 2026-10-26, see `archive/status-log.md`). Cursor Agent only gets its counts from Cursor's server and hands them to hooks; Crush overwrites each session's count with the latest context size. Revisit if either starts keeping a per-call log.
