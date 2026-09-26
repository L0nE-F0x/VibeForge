# To do

Updated for 0.7.0 (2026-09-27): plan limits for Claude, Grok, Kimi and Codex in the rail's usage popover; see `status.md`. Before that, 0.6.0 (2026-09-26): typed CLIs are runs, the "needs you" glow, token usage, the contribution graph and terminal copy/paste.

## Handoff for Monday (2026-09-28)

0.7.0 is tagged and released (plan limits, 2026-09-27). Start here, in this order:

1. **Plan limits in daily use**: turn on Settings → Usage and activity → Show plan limits and keep the rail popover in view for a day. Check the countdowns tick, the day's line climbs, "full in" appears once a window is climbing, and that an expired sign-in (Kimi's lasts 15 minutes when neither Kimi nor the Omarchy widget is renewing it) shows "Sign-in expired" with the last numbers. Compare with the Omarchy widget, whose Kimi row now has its countdown too.
2. **Try 0.6.0's typed-CLI runs with real CLIs** (only stand-ins and bash have been through it). In a Code terminal type `claude`, then `codex`, then `grok`, and check:
   - the pane shows a **run** link while it runs, and after you exit, the run is in Runs with its transcript and diff (and in Needs review only if files changed);
   - switch to another workspace while it thinks: it should stay "working" (pulsing pixel) through a long think, then glow amber when it asks you something or finishes; with VibeForge in the background a notification should open that workspace;
   - resizing the window while a CLI sits idle in a hidden workspace should *not* flag it;
   - `claude --version` leaves no run behind.
3. **Copy and paste in a real Claude Code session**: select text and press Super+C (and Ctrl+C), paste elsewhere; Super+V / Ctrl+V into Claude's prompt; copy an image (a screenshot) and Ctrl+V it into Claude Code, which should still receive it as an image; Ctrl+C with nothing selected should still interrupt.
4. **Usage for Codex and Gemini**: run one short session of each and check the rail popover counts it (the readers follow the documented log formats; neither had logs here). Codex's plan limits should show as bars.
5. **Retake the website's screenshots** (see the recipe in the testing memory): they still show the rocket button and the old Home. Worth showing the contribution graph and the rail's plan limits popover.
6. Then carry on with the list below.


## Next up

**Voice** shipped in 0.5.0 (all four phases; see `status.md`). Next for it:

- [ ] **Try it for real** with the microphone, speakers, real Claude Code and a Codex session, and tune `Endpointer` (src/core/voice.ts) against a real room.
- [ ] **Talk-back from a CLI typed into a shell**, for real: type `claude` in a Code terminal, say something, and check the answer is read aloud (the polish pass wired it; only stand-ins have been through it).
- [ ] **Commands in other languages.** The grammar (src/shared/commands.ts) is English; the wake word works in any language whisper hears.

- [ ] **Gemini plan limits**, when the next Gemini Pro lands: Gemini CLI's `/stats` quota comes from the Code Assist API (`retrieveUserQuota`, per model, with a project from `loadCodeAssist`). Its Google access token lasts an hour and only Gemini CLI renews it, so read-only would show "sign-in expired" unless Gemini CLI ran recently. Work out the request from Gemini CLI's own source before adding it.
- [ ] **Quota notifications** at 80 / 95 / 100% per window, once per reset, like the Omarchy widget's toasts. Skipped in 0.7.0 so the two don't both fire; would need its own switch.
- [ ] **Token usage from more CLIs**: Kimi's session logs weren't read (its plan limits are in 0.7.0), and OpenCode (SQLite now), Copilot, Cursor Agent and Crush weren't looked at.
- [ ] **Translate the rest of the UI.** The forms in Agents, Tasks, Routines and Skills, the engine editor, run details, Home, toast messages, and the errors the main process sends (`src/core/team-service.ts`) are still English. Relative times ("5m ago", `src/shared/text.ts`) should use `Intl.RelativeTimeFormat` in the chosen language. Add each key to `src/ui/i18n/en.ts` first; the typecheck then lists every language that needs it.
- [ ] **Release notes on each tag.** `gh release create vX.Y.Z --notes-file …` after bumping `package.json`; the in-app Update shows those notes.

## Parked

- [ ] **An AUR package**, so Omarchy users can update with `yay`. Parked because the AUR has closed new account registration for now (2026-09-25); watch aur-general or the Arch news feed for it to reopen. The package would set `VIBEFORGE_UPDATE_COMMAND` (or be detected as an "other" install) so the in-app Update points to the package manager.

## Known rough edges

- Restart after an update relaunches with the same arguments and environment; worth a real click on an installer copy after the next release.
- `npm audit` (2026-09-26): 2 high, 2 moderate, none reachable from how the app runs. Electron's two are macOS-only `moveToApplicationsFolder` (not called) and service-worker IPC spoofing (the packaged page registers none, under a strict CSP); `extract-zip` is on Electron's install path; Vitest's is dev-only. Fold them into a dependency pass; don't bump Electron alongside a bug fix.
