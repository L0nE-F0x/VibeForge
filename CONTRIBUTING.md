# Contributing

VibeForge is an open-source desktop for Omarchy. It runs the coding CLIs already on your machine. Issues and pull requests are welcome.

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
npm run build && npm run smoke   # the built app, driven over DevTools (SMOKE_HEADLESS=1: no window)
```

## Issues

Use the [bug](https://github.com/L0nE-F0x/VibeForge/issues/new?template=bug_report.yml) and [feature](https://github.com/L0nE-F0x/VibeForge/issues/new?template=feature_request.yml) templates. **Help → Copy diagnostics** inside the app fills in versions and the end of VibeForge's own log. Read it and remove anything private before you paste.

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

## Pull requests

Open a pull request for anything beyond a typo.

- A title that says what changed
- A summary of what and why
- A test plan (commands you ran, steps you clicked through, or "docs only")
- A linked issue (`Fixes #123`) when there is one

Squash-merge onto `main`. Keep the separate commits only when that history is easier to read than one squashed commit.

## Conduct

Everyone here follows the [code of conduct](CODE_OF_CONDUCT.md).
