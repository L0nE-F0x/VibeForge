# To do

What's next. What shipped is in `CHANGELOG.md` (3.2.0, 2026-11-21, is the latest release), and what has been verified, and how, is in `status.md`.

## Next up

- [ ] **Viby across the app, by voice** (founder, 2026-11-18). Shipped in 2.20.0–2.23.0: the call itself, Mute/Unmute, barge-in while speaking or thinking, natural spoken hang-up, immediate safe execution in calls, warm Piper TTS, 0 ms local navigation, two-pass `inspect` (screens, replies, diffs, files, quotas), `after: true` step chaining, core "waiting for you" prompt notes, `key` TUI answers, `shell`, and `workbench` actions. 2.23.0 makes the Vibe tab the call (a pixel V, live words, and tappable chips), adds faster on-device speech models, and lets Viby read and change settings. 3.0.0 lets Viby do anything in the app you can click and makes it the only voice. Still to do:
  - **Hearing better, the rest.** Talking over Viby has met one desk's speakers (see below): if PipeWire's canceller lets too much through on other setups, the default should become **Never**. Dictation's own start and stop still go by loudness. Silero v6 is published in the same format; v5.1.2 is the one checked.
  - **Speaking up, the rest.** A CLI whose log VibeForge can't read (Cursor Agent, OpenCode, Copilot, Antigravity and the others) gets a completion word only after 20 s of work, without its log answer (though `inspect` can read its terminal screen when asked). Two of the same CLI in one folder share that folder's logs: the newest answer there is the one read.
  - **Quicker answers.** Keeping the planner running persistently between turns might save ~1.5 s of CLI startup; not tried yet.
- [ ] **Muse as a planner**, later (founder, 2026-11-07).
- [ ] **Maybe later:** the desktop voice key (Super+Alt+V) straight to Viby, and a per-workspace strip in Code (the Running list in Viby covers Stop all for now).

## Only checked with stand-ins

- **Workspace sync between two real machines** (2.19.0): on a local network, over Tailscale, and with Omarchy's firewall opened by the command Settings → Sync shows. Everything else about it runs against two real Syncthings on one machine.
- **One phone page for two real computers** (2.21.0): a real phone, over Tailscale, with the desktop and the laptop both shared. Driven so far between two local ports in headless Chrome; a tailnet's names are covered by unit tests only. Settings → Phone's address and QR code were checked against the laptop's real Tailscale (a renamed machine, #98), and the desktop's page was opened over the tailnet at phone size. **Scan its QR code** inside the page has never run: it needs Chrome on Android (the camera and its barcode reader), which no desktop Chrome has. The phone camera opening Settings → Phone's QR code is the same link the tests open, but hasn't been pointed at a real screen.

These work against fake CLIs, synthetic audio and the hidden test window. Nothing is known to be wrong:

- Dictation with a real microphone and Viby's voice on real speakers.
- **A call with Viby**, beyond the founder's first one: whether the pause that ends a turn (0.9 s) feels right over a longer session, whether a real keyboard or the room sets the speech detector off (made-up typing, tones and hiss don't), and Viby speaking up about a real CLI's answer.
- **Talking over Viby on other speakers.** The founder's call (2026-11-18) is the only one on real speakers: Viby stopped cleanly when talked over and didn't cut itself off. Laptop speakers beside their microphone, Bluetooth, a loud room, and whether whisper hears as well through the canceller as without it, are untried. The echo guard (Viby's own words dropped, talking over switched off for the call) has only run in tests.
- The 0.8.0 sounds on real speakers.
- The tray's amber corner and pinning it from the tray's arrow, on the real bar. (The tray and its menu were checked by hand on 2026-09-28.)
- The 2.8.1 Start at login fix across a real login. A real login found the missing icon; the fix was checked against a stand-in tray host.
- Settings → Storage's first upkeep on a large real run folder.
- A task in its own copy on a repository Claude Code hasn't trusted yet.
- **Codex as Viby's planner.** Built to Codex's JSON lines and tested against its real "not signed in" answer. Codex isn't signed in on this machine, so a real plan from it waits for someone who uses Codex.

## Left from recent audits

- [ ] **File names that aren't UTF-8** still go through UTF-8 text when Apply lists what changed. Rare; their content is now carried byte for byte.

## Parked

- [ ] **A buzz when the phone is locked.** The page already buzzes while it is open. A locked phone needs Web Push, which goes through Apple's or Google's push servers: the first third-party service VibeForge would use. Parked on 2026-10-20; if it comes back, it is opt-in and the push carries no content.

- [ ] **An AUR package**, so Omarchy users can update with `yay`. Parked because the AUR has closed new account registration for now (2026-09-25); watch aur-general or the Arch news feed for it to reopen. `packaging/aur/PKGBUILD` (`vibeforge-bin`, `x86_64` and `aarch64`, installing without `.vibeforge-installer` so VibeForge leaves updates to the package manager) and the `linux-arm64` release build are ready in the repository.

## Known rough edges

- **No tokens from Cursor Agent or Crush** (looked at 2026-10-26, see `archive/status-log.md`). Cursor Agent only gets its counts from Cursor's server and hands them to hooks; Crush overwrites each session's count with the latest context size. Revisit if either starts keeping a per-call log.
