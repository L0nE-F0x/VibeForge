# To do

Deploy handoff for 1.1.0 (2026-09-29). 1.0.0 is already tagged (`v1.0.0`, commit `1cf3e95`, same as `main`). 0.8.0 shipped the desk polish and hold-to-talk voice; the 1.0 audit and Electron 44 shipped with 1.0.0. See `CHANGELOG.md`. The Monday checks from that release are done, except the items still listed under Next up.

## Deploy 1.1.0

Two features and two fixes are committed on `feat/saved-run-diff` (one commit each for the features, the workspace fix and the glow fix, then this file), branched from `1cf3e95`, the same commit as `main`, `origin/main` and the tag, and opened as a pull request into `main` on 2026-09-29. Ship them as **1.1.0**: features make it a minor bump under CONTRIBUTING.md, and the fixes ride along. The code is done. This pass is the pull request, the version bump, the tag and the GitHub Release.

`package.json` stays `1.0.0` until the release commit.

### What is already written

The four bullets under `CHANGELOG.md` → `[Unreleased]` are the user-facing notes. Move them into `[1.1.0]` as they stand.

1. **A run keeps the diff from the moment it ended.** When a CLI exits, a pane is closed, or the process is killed mid-task, the run writes `diff.patch` beside `git.txt`: tracked changes since the run began, plus the text of new files (hand-built unified diffs, because `git diff --no-index` writes `1/` and `2/` prefixes). Changes shows that saved patch, so later edits in the folder stay separate. A new file over 256 KB, a binary file, and anything past the caps (2 MB, 200 new files) is named and left in the working tree. The first write of `diff.patch` wins. An empty file means the capture ran and nothing changed. A missing file means an older run, and Changes falls back to a live read. Git is read-only (`--no-optional-locks`, `--no-pager`, colour and mnemonic prefixes off). If VibeForge itself is killed before it can save, the next launch writes the patch with the line `# Saved when VibeForge next opened, because it closed during this run.`
2. **A link in a Code terminal opens the side browser.** An http or https click in a Code terminal opens the side column on the Globe tab and loads that workspace's page. Each workspace keeps its own page, history and scroll while the app is open. The last http(s) address is saved on that workspace, so the next launch reloads it. The back list does not survive quit. Sign-in is shared (one browser profile). Whether the column is open, how wide it is, and Files versus Browser stay one desk-wide choice (`vf.code.side`). The arrow on the address bar opens the system browser. So do links in Help, Settings, Home, the update dialog, agent chat, Tasks, the update terminal and a run's replay.

3. **Open in workspace takes a run to its own workspace.** Continue on a Code run from Runs, then Open in workspace, put the CLI in the workspace Code last showed. The route effect in `src/ui/views/Code.tsx` asked for the run's workspace, but the adopt effect ran in the same pass with the old `current`, adopted the pty there and sent the route back to it. Adoption now waits until the route's workspace is the one on screen. Reproduced and checked on a scratch build (alpha on screen, run continued in beta: before, the pane landed in alpha; after, Code switches to beta and the pane is there).
4. **A CLI started with a prompt glows when its first turn is done** (planned as 1.0.1 on launch day, folded in here). The host marks a shell working while its command line is typed and does not say so again, so `onPtyActivity` dropped the only "working" a `claude "…"` ever got. `TeamService.hostWorking` now keeps the host's last word per shell, and `onPtyProgram` takes it over when a coding CLI is detected. Test: "keeps a CLI working when it starts while the shell is already busy" in `tests/unit/service.test.ts`.

Asked for by SunsetSyntax on the 1.0 announcement: once a pane dies mid-task, the diff matters more than the chat log. The side browser is the follow-up: a local dev server, or any http(s) link in a Code terminal, opens beside the terminals, and switching projects keeps each project's page.

On 2026-09-29, after the fixes, `npm test` passed 154 tests (22 files, including `tests/unit/dock-url.test.ts`), `npm run typecheck` passed, and `npm run build` wrote `dist/` and `dist-electron/`. Re-run test and typecheck for the pull request. The side browser was not clicked in the live window. A window that is already open keeps the previous build until **Quit from the tray** and a fresh start. Closing the window hides VibeForge in the tray and leaves that process up, terminals included. `~/.local/bin/vibeforge` runs the built `dist`. Quit when the desk is free to restart, then do the click-through below.

### Ship it the way 1.0.0 went out

Same shape as #6 then #7: the feature pull request first, then a `chore(release)` pull request, then the tag on the release merge commit.

1. Done: the work is committed on `feat/saved-run-diff`, one Conventional Commit per change, with `package.json` still at `1.0.0` and the changelog under `[Unreleased]`. `dist/` and `dist-electron/` stay untracked (they are gitignored).
2. Done: pushed, with a pull request into `main`, using `.github/PULL_REQUEST_TEMPLATE.md`. `main` is protected by the ruleset Protect main: a pull request is required, force-push and deleting `main` are rejected, and the required checks are `test` and `typecheck`. Squash-merge is the default and uses the pull request title and body. The admin role can merge without a second review. Wait for both checks, then squash-merge.
3. From the updated `main`, branch `chore/release-1.1.0` and:
   - Run `npm version 1.1.0 --no-git-tag-version`. That updates `package.json` and `package-lock.json`. It must leave tag creation to step 5.
   - Move the four `[Unreleased]` bullets to `## [1.1.0] - <the day you publish>`. A headline in the 1.0 voice: **What a run changed stays with it, and a link in Code opens beside the terminal.** Leave an empty `## [Unreleased]` above the new section.
   - In `site/index.html`, match the 1.0 edit. Plate (`class="part"`, the title and the text): `v1.1.0`. Update mock: chip `1.1.1`, "VibeForge 1.1.1 is available. You have 1.1.0.", "VibeForge 1.1.1 is installed.", "Restart to start using 1.1.1." Install terminal: "VibeForge 1.1.0 is installed." Leave `styles.css?v=0.8.0`, `main.js?v=0.8.0` and the screenshot `?v=0.7.0` query strings; those files are unchanged.
   - Replace this Deploy section with a one-line header pointing at 1.1.0. Keep Next up, Parked and Known rough edges.
4. Pull request `chore(release): 1.1.0`, same checks, squash-merge.
5. On that merge commit, annotated tag `v1.1.0`, then `gh release create v1.1.0 --notes-file …` with the `[1.1.0]` section. Publish with notes and no attached files. None of the releases through v1.0.0 have assets: the installer checks out the tag, and the in-app Update shows the notes. A website-only commit after the tag does not reach installer checkouts, so the app changes have to already be in the tagged history. Netlify publishes the site from `main`.

### Click through before the tag

Saved diff, on a fresh start of this build:

- [ ] Finish a CLI run and open Changes. The saved patch is the one from when the run ended. Edit the folder afterwards and "Diff the folder now" can show something else.
- [ ] Stop VibeForge mid-run, before it can snapshot, and reopen. The patch is there, with the note that it was saved when VibeForge next opened.
- [ ] A new text file is inside the patch. A binary file is named and left in the working tree.

Side browser, after a tray Quit and a fresh start:

- [ ] Click an `http://127.0.0.1` link and an `https` link in a Code terminal. The side column opens on the Globe tab and that workspace's page loads. A bare `localhost:5173`, with no scheme, is left as terminal text.
- [ ] Switch to another workspace and you get that project's page, or the empty card. Switch back and the page, the scroll and the Back history are where you left them.
- [ ] Follow a link inside the page. Quit from the tray and reopen: that address loads again. The Back list starts over.
- [ ] Clear the address bar and the empty card stays empty.
- [ ] The arrow on the address bar opens the system browser. So do links in Help, Settings, Home and the update dialog, and links in an agent chat, Tasks and a run's replay.
- [ ] Remove a workspace that had a page open.

Fixes:

- [ ] With workspace A on screen in Code, Continue a stopped run from workspace B in Runs, then Open in workspace. Code switches to B and the CLI is in a pane there, not in A.
- [ ] Type `claude "say hi"` in a Code terminal, switch to another workspace before it answers. When it finishes, that workspace glows and knocks.

Known, and fine to leave: pressing Enter on the address you had before a redirect, while the saved address still equals it, reloads the page you are on. A cleared page can still move itself with in-page history, and typing the old address again can show that moved page. A tray Quit that starts the snapshot and then hits the four-second shutdown wait can miss `diff.patch`; the next open writes it.

## Next up

**Voice** shipped in 0.5.0, and 0.8.0 made it hold-to-talk (see `status.md` and `CHANGELOG.md`). Still to try for real:

- [ ] **Try voice for real** with the microphone, speakers, real Claude Code and a Codex session: hold to dictate, press Enter, and hear the first paragraph.
- [ ] **Talk-back from a CLI typed into a shell**, for real: type `claude` in a Code terminal, dictate a line, press Enter, and check the answer is read aloud (only stand-ins have been through it).
- [ ] **Listen to the 0.8.0 sounds** on real speakers (Settings → Sounds has a play button for each) and say which ones to change.
- [ ] Leave an agent chat thinking, switch to another app, and check the knock, the notification (it should open the chat) and the glow.
- [ ] Ctrl+K from a chat, from Code, and Ctrl+Shift+K from inside a terminal.
- [ ] The tray on the real bar: the icon and its amber corner, pinning it from the tray's arrow, and a real login with Start at login on.

- [ ] **Codex and Gemini usage**, when one of those CLIs is installed here. Run a short session and check the rail popover counts it. Codex's plan limits should show as bars.
- [ ] **Gemini plan limits**, when the next Gemini Pro lands: Gemini CLI's `/stats` quota comes from the Code Assist API (`retrieveUserQuota`, per model, with a project from `loadCodeAssist`). Its Google access token lasts an hour and only Gemini CLI renews it, so read-only would show "sign-in expired" unless Gemini CLI ran recently. Work out the request from Gemini CLI's own source before adding it.
- [ ] **Quota notifications** at 80 / 95 / 100% per window, once per reset, like the Omarchy widget's toasts. Skipped in 0.7.0 so the two don't both fire; would need its own switch.
- [ ] **Token usage from more CLIs**: Kimi's session logs weren't read (its plan limits are in 0.7.0), and OpenCode (SQLite now), Copilot, Cursor Agent and Crush weren't looked at.
- [ ] **Translate the rest of the UI.** The forms in Agents, Tasks, Routines and Skills, the engine editor, run details, Home, toast messages, and the errors the main process sends (`src/core/team-service.ts`) are still English. Relative times ("5m ago", `src/shared/text.ts`) should use `Intl.RelativeTimeFormat` in the chosen language. Add each key to `src/ui/i18n/en.ts` first; the typecheck then lists every language that needs it.
- [ ] **Release notes on each tag.** `gh release create vX.Y.Z --notes-file …` after bumping `package.json`; the in-app Update shows those notes. 1.1.0's are in the Deploy section above.
- [ ] **Undo instead of "are you sure?"** for deleting chats, tasks, skills and routines: delete at once and offer Undo on the toast (the last item from the 2026-09-28 flow audit). Needs a soft delete in `src/core`.

## Parked

- [ ] **An AUR package**, so Omarchy users can update with `yay`. Parked because the AUR has closed new account registration for now (2026-09-25); watch aur-general or the Arch news feed for it to reopen. The package would set `VIBEFORGE_UPDATE_COMMAND` (or be detected as an "other" install) so the in-app Update points to the package manager.

## Known rough edges

- Restart after an update relaunches with the same arguments and environment; worth a real click on an installer copy after the next release.
- `npm audit` (2026-09-28, on Electron 44): only Vitest's advisory, which is dev-only (fixing it is a major bump, not urgent).
