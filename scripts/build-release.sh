#!/usr/bin/env bash
# Makes a release's files and tries them the way a person gets them.
#
#   scripts/build-release.sh <out-dir>
#
# Packs the ready-made build (scripts/pack-release.mjs: the app, Electron, Syncthing, and all of it
# in one archive) into <out-dir>, puts install.sh and a SHA256SUMS for all of them beside it,
# installs it with that install.sh into a scratch home (the files laid out like a release, over
# file://), and runs the installed copy's own smoke test. Then scripts/try-updates.sh updates an
# install of the last release before versioned installs to it, goes back, updates again, is
# stopped part-way, installs fresh and uninstalls (VIBEFORGE_TRY_UPDATES=0 skips that). CI's smoke
# job runs this on every pull request and push to main, so packing is proven before a tag; then
# release.yml runs it for the tag and attaches what is left in <out-dir>.
#
# The smoke test needs a display: CI wraps this in xvfb-run, and SMOKE_HEADLESS=1 runs it with none
# (SMOKE_PORT picks its DevTools port). VIBEFORGE_PACK_REF packs another commit.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
out="$(realpath -m "${1:?usage: scripts/build-release.sh <out-dir>}")"

# The archives in the folder: the ones packed now.
mkdir -p "$out"
rm -f "$out"/vibeforge-*-linux-*.tar.zst "$out"/electron-*-linux-*.tar.zst "$out"/syncthing-*-linux-*.tar.zst
node "$root/scripts/pack-release.mjs" "$out"
archives=("$out"/vibeforge-[0-9]*-linux-*.tar.zst)
file="$(basename "${archives[0]}")"
version="${file#vibeforge-}"
version="${version%-linux-*}"

cp "$root/scripts/install.sh" "$out/install.sh"
(cd "$out" && sha256sum install.sh ./*.tar.zst | sed 's,  \./,  ,' >SHA256SUMS)
cat "$out/SHA256SUMS"

scratch="$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/vibeforge-try.XXXXXX")"
trap 'rm -rf "$scratch"' EXIT
mkdir -p "$scratch/releases/download" "$scratch/home"
ln -s "$out" "$scratch/releases/download/v$version"

printf '\n▸ Installing it as a person would, into %s\n' "$scratch/home"
# Only a home and a PATH, so it can't lean on anything else in this environment.
env -i HOME="$scratch/home" PATH="$PATH" VIBEFORGE_RELEASES="file://$scratch/releases" VIBEFORGE_VERSION="v$version" \
  bash "$out/install.sh"
app="$scratch/home/.local/share/vibeforge-app"
if [[ ! -L "$app/current" || -e "$app/current/.git" || ! -e "$app/current/.vibeforge-installer" || ! -L "$app/current/node_modules/electron/dist" ]]; then
  echo "✗ The installer did not install the split ready-made build into versions/." >&2
  exit 1
fi

printf '\n▸ The smoke test, from the installed copy\n'
node "$app/current/scripts/smoke.mjs"

if [[ "${VIBEFORGE_TRY_UPDATES:-1}" != 0 ]]; then
  printf '\n▸ Updating to it from an older install, going back, and being stopped part-way\n'
  "$root/scripts/try-updates.sh" "$out"
fi
