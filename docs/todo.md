# To do

Updated after the 0.3.0 pass (2026-09-25): in-app updates, languages, diagnostics and the move to vibe-forge.net are done; see `status.md`.

## Next up

- [ ] **Make vibe-forge.net the primary domain** in Netlify (Domain management → set as primary), so vibeforgeapp.netlify.app redirects to it. Everything in the repo already points at vibe-forge.net.
- [ ] **Translate the rest of the UI.** The forms in Agents, Tasks, Routines and Skills, the engine editor, run details, Home, toast messages, and the errors the main process sends (`src/core/team-service.ts`) are still English. Relative times ("5m ago", `src/shared/text.ts`) should use `Intl.RelativeTimeFormat` in the chosen language. Add each key to `src/ui/i18n/en.ts` first; the typecheck then lists every language that needs it.
- [ ] **An AUR package**, so Omarchy users can update with `yay`. It would set `VIBEFORGE_UPDATE_COMMAND` (or be detected as an "other" install) so the in-app Update says to use the package manager.
- [ ] **Release notes on each tag.** `gh release create vX.Y.Z --notes-file …` after bumping `package.json`; the in-app Update shows those notes.

## Known rough edges

- Restart after an update relaunches with the same arguments and environment; worth a real click on an installer copy after the next release.
