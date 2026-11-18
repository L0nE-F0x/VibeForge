# To do

What's next. What shipped is in `CHANGELOG.md` (2.19.0, 2026-11-17, is the latest release), and what has been verified, and how, is in `status.md`.

## Next up

- [ ] **Viby across the app, by voice** (founder, 2026-11-18). In (Unreleased): the call itself (the rail's Call button, the call bar, spoken go/cancel/hang up), what you're looking at said to Viby with each request, `show` for any workspace or view, the window following Viby during a call, Viby speaking up when a CLI it started or told ends its turn, the `read` step ("what did Claude say?"), the Silero speech detector, and talking over Viby with PipeWire's echo cancellation or headphones. Still to do:
  - **Hearing better, the rest.** Talking over Viby has met one desk's speakers (see below): if PipeWire's canceller lets too much through on other setups, the default should become **Never**. Viby can't be interrupted while it thinks, only while it speaks. Dictation's own start and stop still go by loudness. Silero v6 is published in the same format; v5.1.2 is the one checked.
  - **Speaking up, the rest.** A CLI whose log VibeForge can't read (Cursor Agent, OpenCode, Copilot, Antigravity and the others) gets a word only after 20 s of work, without its answer, and its answer is never read aloud. Two of the same CLI in one folder share that folder's logs: the newest answer there is the one read.
  - **Quicker answers.** A planning turn with Viby's real rules took 7–8 s with Claude Code on its default model, and about 5 s on Haiku or Sonnet (Settings → Viby → Model), new session or resumed (measured 2026-11-18; about 1.5 s of it is the CLI starting). Keeping the planner running between turns might save a second; not tried.
- [ ] **Muse as a planner**, later (founder, 2026-11-07).
- [ ] **Maybe later:** the desktop voice key (Super+Alt+V) straight to Viby, and a per-workspace strip in Code (the Running list in Viby covers Stop all for now).

## Only checked with stand-ins

- **Workspace sync between two real machines** (2.19.0): on a local network, over Tailscale, and with Omarchy's firewall opened by the command Settings → Sync shows. Everything else about it runs against two real Syncthings on one machine.

These work against fake CLIs, synthetic audio and the hidden test window. Nothing is known to be wrong:

- Dictation and talk-back with a real microphone and speakers, including talk-back from a CLI typed into a Code terminal.
- **A call with Viby**, beyond the founder's first one: whether the pause that ends a turn (0.9 s) feels right over a longer session, whether a real keyboard or the room sets the speech detector off (made-up typing, tones and hiss don't), and Viby speaking up about a real CLI's answer.
- **Talking over Viby on other speakers.** The founder's call (2026-11-18) is the only one on real speakers: Viby stopped cleanly when talked over and didn't cut itself off. Laptop speakers beside their microphone, Bluetooth, a loud room, and whether whisper hears as well through the canceller as without it, are untried. The echo guard (Viby's own words dropped, talking over switched off for the call) has only run in tests.
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
