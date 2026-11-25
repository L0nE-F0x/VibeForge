# Contributing

VibeForge is an open-source desktop for Omarchy. It runs the coding CLIs already on your machine. Issues and pull requests are welcome.

Read [the principles](docs/principles.md) before proposing a feature. They are why VibeForge holds no API keys, sends nothing by default except the update check, and waits for a person at each step. A change that breaks one needs a reason in its pull request.

A short-lived branch and a clear pull request keep `main` readable once more than one person is changing it.

## Set up

Linux, on Omarchy or another Arch + Hyprland setup. The [README](README.md) covers install, what the app does, and where your files live.

```bash
git clone https://github.com/L0nE-F0x/VibeForge.git
cd VibeForge
npm install
npm start            # Vite + Electron, with hot reload
npm test             # unit tests and the real PTY host, driven with /bin/bash
npm run typecheck
npm run lint         # Biome, bug-shaped rules only; nothing is reformatted
npm run coverage     # the tests again, with a floor on src/core (CI runs this one)
npm run build && npm run smoke   # the built app, driven over DevTools (SMOKE_HEADLESS=1: no window)
npm run e2e          # the end-to-end scenarios in e2e/, on the built app (see below)
```

### Beside an installed VibeForge

Electron runs one VibeForge per profile folder, and the profile is `~/.config/VibeForge` unless it's told otherwise. So a dev copy started while your installed VibeForge runs only brings that window forward and quits. Without its own folders it would also read and write your real agents, runs and settings.

Give the dev copy its own folders, as `scripts/smoke.mjs` does:

```bash
dev=~/vibeforge-dev   # any folder; VibeForge fills it on first start
npm run build
VIBEFORGE_CONFIG=$dev/config VIBEFORGE_DATA=$dev/data \
  node_modules/electron/dist/electron . --user-data-dir=$dev/profile
```

`VIBEFORGE_CONFIG` and `VIBEFORGE_DATA` stand in for `~/.config/vibeforge` and `~/.local/share/vibeforge`, which also gives the copy its own control socket: its terminals talk to it, and Super+Alt+V still reaches your installed VibeForge. `--user-data-dir` moves Electron's profile and its one-copy lock. `npm start` takes no Electron flags; for hot reload, set `VIBEFORGE_PROFILE` and it passes `--user-data-dir` for you:

```bash
VIBEFORGE_CONFIG=$dev/config VIBEFORGE_DATA=$dev/data VIBEFORGE_PROFILE=$dev/profile npm start
```

The copy gets its own tray icon. Turn the phone page on in only one of them, since both would listen on port 4737.

A copy started on folders another VibeForge is already using (the same `VIBEFORGE_CONFIG` or `VIBEFORGE_DATA`, whatever its `--user-data-dir`) doesn't start: it says which folder is taken and exits.

## End-to-end tests

`e2e/` holds scenarios that start the built app and use it as a person would: they click buttons by their names, type with key events, and wait for what the window shows. `npm run e2e` runs them all after `npm run build`; `npx vitest run --config vitest.e2e.config.mts e2e/task-copy.e2e.ts` runs one file.

- **Nothing of yours is touched.** Each scenario starts its own VibeForge with scratch config, data, home and Electron profile, `TZ=UTC`, English, a fixed window size, and no window on your screen (`--ozone-platform=headless`; `E2E_HEADLESS=0` opens a real window on the display that is set instead, which CI doesn't use and hasn't been tried). It runs beside an installed VibeForge. The window is driven over `--remote-debugging-pipe`, so no port is opened, and the window's requests to anywhere but this machine are refused and listed (`app.blockedRequests`).
- **Stand-in CLIs.** `launchApp({ standins: { claude: {...} } })` puts a `claude` on the app's PATH that is `e2e/standins/standin.cjs`: as Viby's planner it answers with the plans you give it; in a terminal it prints, waits at a gate until the test calls `app.openGate(...)`, then edits files and exits. Its header comment has the format. The PATH holds nothing from your home, so your real CLIs never run.
- **Waits are on conditions.** `app.waitFor(check, { what })` polls until the check is true. There are no fixed sleeps; a turn ends when the test opens its gate.
- **When one fails,** its scratch folder is kept with `evidence/`: a screenshot, the page's HTML, the app's output, each live terminal's text and why it stopped. The folders go to `E2E_OUT` (default: `vibeforge-e2e` in your temporary folder); a passing scenario's folder is removed unless `E2E_KEEP=1`. Keep `TMPDIR` short: Chromium's lock socket lives there, and a path over about 100 characters stops the app at start.
- **The driver** is `e2e/driver/app.ts`: `call` and `eval` reach VibeForge and the page, `click({ name, role, within })`, `key("Ctrl+Shift+D")`, `type(...)` and `go("Tasks")` act, `terminal(ptyId).waitForText(...)` reads a terminal, `restart()` quits and starts on the same profile, and `refuse([...])` makes the main process refuse the window's calls (with `mainProcess: true`), as a folder it can't read would.

A new scenario should pass several runs in a row, alone and beside the others (`npm run e2e` runs two files at a time), before it goes in: a scenario that fails now and then costs more than it finds.

## In CI

`.github/workflows/ci.yml` runs every check on each pull request. The test steps run through `scripts/ci-test.mjs`, which writes JSON and JUnit reports (uploaded as `test-reports-*`). When a check fails, its evidence is uploaded with it: the smoke test's screenshot, page and logs, and each failed scenario's folder.

A test that fails now and then for a reason outside the change goes in `tests/flaky.json`, with the cause and a link to where its fix is tracked. When the only failures in a run are tests on that list, CI runs those once more; if they pass, the job passes, with a warning on the run and a line in the job summary. Everything else that fails, fails. Each Monday, `flaky-report.yml` rewrites one issue labelled `flaky-tests` with the tests that failed that week and the jobs that only passed when re-run. Take an entry off the list once that issue has shown no retry of it for two weeks.

`nightly.yml` runs each night on `main`, and on every push to a `release/` branch: the tests on arm64 and on Ubuntu 24.04 with the newest Node patches, the ready-made build packed and smoke-tested on x64 and arm64, and the build and tests after an `npm update`. A failed night opens or updates an issue labelled `nightly-failure`. To run it on a branch before tagging: `gh workflow run nightly.yml --ref <branch>`.

## Issues

Use the [bug](https://github.com/L0nE-F0x/VibeForge/issues/new?template=bug_report.yml) and [feature](https://github.com/L0nE-F0x/VibeForge/issues/new?template=feature_request.yml) templates. **Help → Copy diagnostics** inside the app fills in versions and the end of VibeForge's own log. Read it and remove anything private before you paste.

A security problem goes to a private report, as [SECURITY.md](SECURITY.md) says, not to an issue.

| Label | Meaning |
| --- | --- |
| `bug` | Something does not work |
| `enhancement` | A feature or idea |
| `documentation` | Docs only |
| `good first issue` | A contained change for someone new to the code |
| `help wanted` | Extra hands are useful |
| `needs triage` | A maintainer has not sorted this yet |

## Branches

Branch off `main`. Keep the branch short-lived and named for the change (`fix/last-terminal-closes`, `docs/changelog`).

## Commits

Use [Conventional Commits](https://www.conventionalcommits.org/). The type makes the history scannable when several people are committing.

`feat`, `fix`, `docs`, `chore`, `refactor`, `test`, `ci`

Write the subject in the imperative, and keep it short: `fix: close the workspace when its last terminal exits`. Add a body when the reason is not obvious from the subject.

## Versions

Since `1.0.0`, versions follow [semantic versioning](https://semver.org/). A change that breaks something people rely on bumps the major version: files in `~/.config/vibeforge` that the new version reads differently or not at all, a `vibeforge` command-line flag or a keybinding that changes, or a feature that goes away. New features bump the minor version, and fixes bump the patch. The `0.x` releases before it bumped the minor version for both features and breaking changes.

`package.json`, the git tag (`vX.Y.Z`), and the GitHub Release stay on the same number. Tags are cut by the maintainer when a release is published.

User-facing changes get an entry in [CHANGELOG.md](CHANGELOG.md) under `Unreleased`. The maintainer moves that entry when the release is published, and adds the version's link at the bottom (`[X.Y.Z]: …/releases/tag/vX.Y.Z`, and `[Unreleased]` comparing from that tag). Each heading is a link, so a missing line leaves the version unlinkable. A test checks that every heading has one.

Pushing a `vX.Y.Z` tag publishes its GitHub Release (`.github/workflows/release.yml`): the notes are that version's CHANGELOG section, word for word, which is what the in-app Update shows. The tag has to match `package.json`. `npm run release-notes X.Y.Z` prints the same notes locally.

The release also carries the ready-made build the installer downloads, so nobody compiles anything to install or update. For each CPU there are four archives: `vibeforge-app-X.Y.Z-linux-x64.tar.zst` (the app, about 2 MB), `electron-<version>-linux-x64.tar.zst` and `syncthing-<version>-linux-x64.tar.zst`, which an update downloads only when the computer doesn't have that one yet, and `vibeforge-X.Y.Z-linux-x64.tar.zst` with all of it, for anyone who downloads by hand. The app archive's `manifest.json` names the Electron and Syncthing it needs and the SHA-256 of their files (`tree_hash` in `install.sh`), so the installer reuses a copy only when it is identical. `scripts/pack-release.mjs` makes them: it exports the commit, runs `npm ci` and the build in a scratch folder, and packs only what the app runs (whole folders, listed in the script; `tests/unit/pack-release.test.ts` keeps the list in step with the files the app opens). If what goes into the Electron or Syncthing archive changes, its hash changes with it, and installs download it again. `scripts/build-release.sh` packs them, writes `install.sh` and a `SHA256SUMS` for all of them beside them, installs them with that `install.sh` into a scratch home the way a person would, and runs the smoke test from the installed copy. Then `scripts/try-updates.sh` downloads v3.7.2 (the last release before versioned installs) and checks it against its `SHA256SUMS`, installs it with its own installer, updates it to the new build the way its Update does, goes back, updates again, kills updates part-way, installs fresh and uninstalls, in scratch homes, with the smoke test from the installed copy after the steps that change what starts (`TRY_SMOKE=all` after every step). CI's smoke job runs that on every pull request, and `release.yml` runs it for the tag once the checks have passed, then attaches all the files in the one `gh release create` (a published release can't be changed). To try it on your machine (it packs the last commit, not uncommitted changes):

```bash
SMOKE_HEADLESS=1 scripts/build-release.sh release    # release/: the four archives, install.sh, SHA256SUMS
```

## Pull requests

Open a pull request for anything beyond a typo.

- A title that says what changed
- A summary of what and why
- A test plan (commands you ran, steps you clicked through, or "docs only")
- A linked issue (`Fixes #123`) when there is one

Squash-merge onto `main`. Keep the separate commits only when that history is easier to read than one squashed commit.

## Conduct

Everyone here follows the [code of conduct](CODE_OF_CONDUCT.md).
