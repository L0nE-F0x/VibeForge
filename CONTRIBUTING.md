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

User-facing changes get an entry in [CHANGELOG.md](CHANGELOG.md) under `Unreleased`. The maintainer moves that entry when the release is published.

Pushing a `vX.Y.Z` tag publishes its GitHub Release (`.github/workflows/release.yml`): the notes are that version's CHANGELOG section, word for word, which is what the in-app Update shows. The tag has to match `package.json`. `npm run release-notes X.Y.Z` prints the same notes locally.

The release also carries the ready-made build the installer downloads, `vibeforge-X.Y.Z-linux-x64.tar.zst`, so nobody compiles anything to install or update. `release.yml` makes it once the tagged commit's checks have passed: `scripts/pack-release.mjs` exports the commit, runs `npm ci` and the build in a scratch folder, and packs only what the app runs (the list is in the script, and `tests/unit/pack-release.test.ts` keeps it in step with the files the app opens). The workflow then installs the archive with `scripts/install.sh` into a scratch home, runs the smoke test from that installed copy, and publishes the archive with `install.sh` and a `SHA256SUMS` for both. To build and try one on your machine:

```bash
node scripts/pack-release.mjs        # packs the last commit (not uncommitted changes) into release/
v=$(node -p 'require("./package.json").version')
mkdir -p /tmp/vf-rel/download && ln -sfn "$PWD/release" "/tmp/vf-rel/download/v$v"
cp scripts/install.sh release/ && (cd release && sha256sum install.sh "vibeforge-$v-linux-x64.tar.zst" >SHA256SUMS)
HOME=$(mktemp -d) VIBEFORGE_RELEASES=file:///tmp/vf-rel VIBEFORGE_VERSION="v$v" bash scripts/install.sh
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
