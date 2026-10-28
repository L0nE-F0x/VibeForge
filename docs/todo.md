# To do

What's next. What shipped is in `CHANGELOG.md` (2.9.0, 2026-10-28, is the latest release), and what has been verified, and how, is in `status.md`.

## Next up

The team, parts 2 and 3 (agreed 2026-10-28; part 1, CLIs told about each other and tasks reporting back, is in `status.md`). A lead is one of your own agents and decides who does what; VibeForge never routes by itself.

- [ ] **A lead and its team (2.11.0).** Mark one agent the lead of a workspace. Each agent gets a short "good at" line and a cost tier, which the lead is given with the rules. **Settings → Agents together**: Off, **Ask first** (the lead shows its plan, you press Go; the default) or **Go ahead** within caps: agents at once, which agents, hand-offs per request. The lead's Claude Code gets `Bash(vibeforge:*)` allowed only under Go ahead. Who applies helpers' work: you, with an option to let the lead.
- [ ] **Watching the team (2.12.0).** A quiet strip per workspace: the lead, each helper, what it's doing and its result, and Stop all.

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
