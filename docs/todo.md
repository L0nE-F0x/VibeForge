# To do

Updated for 0.8.0 (2026-09-28): a desk that keeps your place (view memory, drafts, sounds, Ctrl+K, the tray, hold-to-talk voice); see `CHANGELOG.md`. Before that, 0.7.0 (2026-09-27): plan limits for Claude, Grok, Kimi and Codex in the rail's usage popover; see `status.md`. Before that, 0.6.0 (2026-09-26): typed CLIs are runs, the "needs you" glow, token usage, the contribution graph and terminal copy/paste.

## Monday (2026-09-28)

The handoff's checks 1–3 passed in daily use: plan limits in the rail popover, typed `claude` / `grok` runs (run link, transcript and diff, the amber glow), and copy and paste in a real Claude Code session. Check 4 (Codex and Gemini usage) is waiting until one of those CLIs is installed here.

Last night's voice simplification and the blank-screen / Grok-prompt fixes are uncommitted on purpose: they go out with the next batch of changes as one pull request, following CONTRIBUTING.md.

Since then, on the `feat/desk-polish` branch: views remember where you were (across restarts), sounds, agent chats that glow and notify, drafts that survive, Ctrl+K, back/forward and arrow keys in lists (see `status.md`). Try by ear and hand:

- [ ] **Listen to the sounds** on real speakers (Settings → Sounds has a play button for each) and say which ones to change.
- [ ] Leave an agent chat thinking, switch to another app, and check the knock, the notification (it should open the chat) and the glow.
- [ ] Ctrl+K from a chat, from Code, and Ctrl+Shift+K from inside a terminal.
- [ ] The tray on the real bar: the icon and its amber corner, pinning it from the tray's arrow, and a real login with Start at login on.


## Next up

**Voice** shipped in 0.5.0 (all four phases; see `status.md`). Next for it:

- [ ] **Try it for real** with the microphone, speakers, real Claude Code and a Codex session: hold to dictate, press Enter, and hear the first paragraph.
- [ ] **Talk-back from a CLI typed into a shell**, for real: type `claude` in a Code terminal, dictate a line, press Enter, and check the answer is read aloud (only stand-ins have been through it).

- [ ] **Gemini plan limits**, when the next Gemini Pro lands: Gemini CLI's `/stats` quota comes from the Code Assist API (`retrieveUserQuota`, per model, with a project from `loadCodeAssist`). Its Google access token lasts an hour and only Gemini CLI renews it, so read-only would show "sign-in expired" unless Gemini CLI ran recently. Work out the request from Gemini CLI's own source before adding it.
- [ ] **Quota notifications** at 80 / 95 / 100% per window, once per reset, like the Omarchy widget's toasts. Skipped in 0.7.0 so the two don't both fire; would need its own switch.
- [ ] **Token usage from more CLIs**: Kimi's session logs weren't read (its plan limits are in 0.7.0), and OpenCode (SQLite now), Copilot, Cursor Agent and Crush weren't looked at.
- [ ] **Translate the rest of the UI.** The forms in Agents, Tasks, Routines and Skills, the engine editor, run details, Home, toast messages, and the errors the main process sends (`src/core/team-service.ts`) are still English. Relative times ("5m ago", `src/shared/text.ts`) should use `Intl.RelativeTimeFormat` in the chosen language. Add each key to `src/ui/i18n/en.ts` first; the typecheck then lists every language that needs it.
- [ ] **Release notes on each tag.** `gh release create vX.Y.Z --notes-file …` after bumping `package.json`; the in-app Update shows those notes.

- [ ] **Undo instead of "are you sure?"** for deleting chats, tasks, skills and routines: delete at once and offer Undo on the toast (the last item from the 2026-09-28 flow audit). Needs a soft delete in `src/core`.

## Parked

- [ ] **An AUR package**, so Omarchy users can update with `yay`. Parked because the AUR has closed new account registration for now (2026-09-25); watch aur-general or the Arch news feed for it to reopen. The package would set `VIBEFORGE_UPDATE_COMMAND` (or be detected as an "other" install) so the in-app Update points to the package manager.

## Known rough edges

- Restart after an update relaunches with the same arguments and environment; worth a real click on an installer copy after the next release.
- `npm audit` (2026-09-26): 2 high, 2 moderate, none reachable from how the app runs. Electron's two are macOS-only `moveToApplicationsFolder` (not called) and service-worker IPC spoofing (the packaged page registers none, under a strict CSP); `extract-zip` is on Electron's install path; Vitest's is dev-only. Fold them into a dependency pass; don't bump Electron alongside a bug fix.
