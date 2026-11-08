#!/usr/bin/env bash
# Makes a release's files and tries them the way a person gets them.
#
#   scripts/build-release.sh <out-dir>
#
# Packs the ready-made build (scripts/pack-release.mjs) into <out-dir>, puts install.sh and a
# SHA256SUMS for both beside it, installs it with that install.sh into a scratch home (the files
# laid out like a release, over file://), and runs the installed copy's own smoke test. CI's smoke
# job runs this on every pull request and push to main, so packing is proven before a tag; then
# release.yml runs it for the tag and attaches what is left in <out-dir>.
#
# The smoke test needs a display: CI wraps this in xvfb-run, and SMOKE_HEADLESS=1 runs it with none
# (SMOKE_PORT picks its DevTools port). VIBEFORGE_PACK_REF packs another commit.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
out="$(realpath -m "${1:?usage: scripts/build-release.sh <out-dir>}")"

# One archive in the folder: the one packed now.
mkdir -p "$out"
rm -f "$out"/vibeforge-*-linux-*.tar.zst
node "$root/scripts/pack-release.mjs" "$out"
archives=("$out"/vibeforge-*-linux-*.tar.zst)
file="$(basename "${archives[0]}")"
version="${file#vibeforge-}"
version="${version%-linux-*}"

cp "$root/scripts/install.sh" "$out/install.sh"
(cd "$out" && sha256sum install.sh "$file" >SHA256SUMS)
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
if [[ -e "$app/.git" || ! -e "$app/.vibeforge-installer" ]]; then
  echo "✗ The installer built from source instead of installing the archive." >&2
  exit 1
fi

printf '\n▸ The smoke test, from the installed copy\n'
node "$app/scripts/smoke.mjs"
