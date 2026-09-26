# To do

Updated after the 0.3.0 pass (2026-09-25): in-app updates, languages, diagnostics and the move to vibe-forge.net are done; see `status.md`.

## Next up

**Voice** shipped in 0.5.0 (all four phases; see `status.md`). Next for it:

- [ ] **Try it for real** with the microphone, speakers, real Claude Code and a Codex session, and tune `Endpointer` (src/core/voice.ts) against a real room.
- [ ] **Talk-back from a CLI typed into a shell**, for real: type `claude` in a Code terminal, say something, and check the answer is read aloud (the polish pass wired it; only stand-ins have been through it).
- [ ] **Commands in other languages.** The grammar (src/shared/commands.ts) is English; the wake word works in any language whisper hears.

- [ ] **Translate the rest of the UI.** The forms in Agents, Tasks, Routines and Skills, the engine editor, run details, Home, toast messages, and the errors the main process sends (`src/core/team-service.ts`) are still English. Relative times ("5m ago", `src/shared/text.ts`) should use `Intl.RelativeTimeFormat` in the chosen language. Add each key to `src/ui/i18n/en.ts` first; the typecheck then lists every language that needs it.
- [ ] **Release notes on each tag.** `gh release create vX.Y.Z --notes-file …` after bumping `package.json`; the in-app Update shows those notes.

## Parked

- [ ] **An AUR package**, so Omarchy users can update with `yay`. Parked because the AUR has closed new account registration for now (2026-09-25); watch aur-general or the Arch news feed for it to reopen. The package would set `VIBEFORGE_UPDATE_COMMAND` (or be detected as an "other" install) so the in-app Update points to the package manager.

## Known rough edges

- Restart after an update relaunches with the same arguments and environment; worth a real click on an installer copy after the next release.
- `npm audit` (2026-09-26): 2 high, 2 moderate, none reachable from how the app runs. Electron's two are macOS-only `moveToApplicationsFolder` (not called) and service-worker IPC spoofing (the packaged page registers none, under a strict CSP); `extract-zip` is on Electron's install path; Vitest's is dev-only. Fold them into a dependency pass; don't bump Electron alongside a bug fix.
