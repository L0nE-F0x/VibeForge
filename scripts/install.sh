#!/usr/bin/env bash
# VibeForge installer for Omarchy (and other Arch + Hyprland setups).
#
#   curl -fsSL https://vibe-forge.net/install | bash
#
# Downloads the newest release's ready-made build into ~/.local/share/vibeforge-app, checks it
# against the release's SHA256SUMS, and adds a `vibeforge` command plus an app-launcher entry. That
# takes curl, tar, zstd and sha256sum, which every Arch install has, and Node, which the terminals
# run on. Nothing is compiled. Run it again (or use Update in the app) to update.
#
# It builds from source instead (git clone, npm ci and a Vite build, which need git, base-devel and
# python) when VIBEFORGE_FROM_SOURCE=1, when VIBEFORGE_BRANCH names a branch to follow
# (VIBEFORGE_BRANCH=main for unreleased work), when the release has no ready-made build (older ones
# don't) or none for this CPU. It says which way it went. VIBEFORGE_VERSION=v2.15.0 installs that
# release instead of the newest. `--uninstall` removes the command, launcher entry and login entry
# but keeps your agents, routines and runs.
#
# An update is unpacked (or built) beside the installed copy, in vibeforge-app.next, and swapped in
# only once it is whole, so a dropped network, a bad download or a failed build leaves the installed
# copy as it was. The copy it replaced stays in vibeforge-app.previous; to go back, quit VibeForge
# and swap the two.
#
# VIBEFORGE_RELEASES is where releases are downloaded from, by default VIBEFORGE_REPO's releases on
# GitHub: <releases>/latest redirects to <releases>/tag/<tag>, and a release's files are in
# <releases>/download/<tag>/. It is there for tests and mirrors; a file:// one needs VIBEFORGE_VERSION.
#
# Everything runs from main(), called on the last line: a download cut off part-way runs nothing.
set -euo pipefail

REPO="${VIBEFORGE_REPO:-https://github.com/L0nE-F0x/VibeForge.git}"
BRANCH="${VIBEFORGE_BRANCH:-}"
VERSION="${VIBEFORGE_VERSION:-}"
RELEASES="${VIBEFORGE_RELEASES:-}"
DEST="${VIBEFORGE_HOME:-$HOME/.local/share/vibeforge-app}"
BIN_DIR="$HOME/.local/bin"
APPS_DIR="$HOME/.local/share/applications"
ICON_DIR="$HOME/.local/share/icons/hicolor"
# The entry Settings → Start at login writes (src/core/autostart.ts).
AUTOSTART="${XDG_CONFIG_HOME:-$HOME/.config}/autostart/vibeforge.desktop"
# Lets the app know a copy is the installer's, so its Update button runs this script.
MARK=".vibeforge-installer"
# The PATH this started with, before main() adds mise's shims and $BIN_DIR to it.
START_PATH="${PATH:-}"
PREVIOUS=""
STAGE=""
FETCHED=""
SWAPPED=0
# Set by fetch_archive when the release has no ready-made build for this CPU.
NO_ARCHIVE=""

ember=$'\033[38;2;255;107;53m'
amber=$'\033[38;2;252;163;17m'
dim=$'\033[2m'
bold=$'\033[1m'
reset=$'\033[0m'

step() { printf '%s▸%s %s\n' "$ember" "$reset" "$*"; }
note() { printf '  %s%s%s\n' "$dim" "$*" "$reset"; }
die() {
  printf '\033[31m✗ %s\033[0m\n' "$*" >&2
  exit 1
}

uninstall() {
  step "Removing the vibeforge command, launcher entry and login entry"
  rm -f "$BIN_DIR/vibeforge" "$APPS_DIR/vibeforge.desktop" "$AUTOSTART"
  rm -f "$ICON_DIR/512x512/apps/vibeforge.png" "$ICON_DIR/256x256/apps/vibeforge.png" "$ICON_DIR/scalable/apps/vibeforge.svg"
  command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "$APPS_DIR" >/dev/null 2>&1 || true
  note "The app itself is still in $DEST. Delete it with: rm -rf \"$DEST\" \"$DEST.previous\""
  note "Your data is untouched: ~/.config/vibeforge and ~/.local/share/vibeforge"
  exit 0
}

# The tag of the latest release, from where <releases>/latest redirects: the same release the app's
# Update checks for, so a stray tag that was never released can't win. Prints nothing if it can't ask.
latest_release_tag() {
  [[ -n "$RELEASES" ]] || return 0
  command -v curl >/dev/null 2>&1 || return 0
  local url
  url=$(curl -fsS -o /dev/null -w '%{redirect_url}' --max-time 15 "$RELEASES/latest" 2>/dev/null) || return 0
  if [[ "$url" =~ /tag/([^/?#]+)$ ]]; then printf '%s' "${BASH_REMATCH[1]}"; fi
}

# On the way out: a half-built or half-downloaded copy is removed, and a failed update says the
# installed one is as it was.
finish() {
  local status=$?
  if [[ -n "$STAGE" && -e "$STAGE" ]]; then rm -rf "$STAGE"; fi
  if [[ -n "$FETCHED" && -e "$FETCHED" ]]; then rm -rf "$FETCHED"; fi
  if ((status != 0 && !SWAPPED)) && [[ -f "$DEST/dist-electron/main.js" ]]; then
    note "The installed copy in $DEST is unchanged."
  fi
  return "$status"
}

# The release's ready-made build for this CPU, downloaded, checked against the release's SHA256SUMS
# and unpacked into $STAGE. When the release has none, NO_ARCHIVE says why and nothing is unpacked.
fetch_archive() {
  local tag="$1" arch="$2" file expected actual status=0
  file="vibeforge-${tag#v}-linux-$arch.tar.zst"
  FETCHED="$DEST.download"
  rm -rf "$FETCHED"
  mkdir -p "$FETCHED"
  curl -fsSL --retry 2 --connect-timeout 20 --max-time 60 -o "$FETCHED/SHA256SUMS" "$RELEASES/download/$tag/SHA256SUMS" || status=$?
  case "$status" in
    0) ;;
    # Not found (an HTTP error, or a file:// path that isn't there): a release from before these builds.
    22 | 37)
      NO_ARCHIVE="the $tag release has no ready-made build"
      return 0
      ;;
    *) die "Could not download $tag's checksums (curl error $status). Check the network, then run this again." ;;
  esac
  expected=$(awk -v f="$file" '$2 == f || $2 == "*" f { print $1; exit }' "$FETCHED/SHA256SUMS")
  if [[ -z "$expected" ]]; then
    NO_ARCHIVE="the $tag release has no ready-made build for linux-$arch"
    return 0
  fi
  [[ "$expected" =~ ^[0-9a-f]{64}$ ]] || die "$tag's SHA256SUMS does not read as checksums, so nothing was installed."

  step "Downloading VibeForge ${tag#v}, ready-made for linux-$arch"
  curl -fSL --retry 2 --connect-timeout 20 --progress-bar -o "$FETCHED/$file" "$RELEASES/download/$tag/$file" ||
    die "The download stopped part-way. Check the network, then run this again."
  actual=$(sha256sum "$FETCHED/$file")
  actual="${actual%% *}"
  [[ "$actual" == "$expected" ]] ||
    die "The download does not match $tag's SHA256SUMS, so it was not installed. Run this again; if it keeps happening, open an issue on GitHub."
  note "It matches the release's SHA256SUMS."

  # The copy from two updates ago goes first, so the disk holds two copies at most, not three.
  rm -rf "$PREVIOUS"
  mkdir -p "$STAGE"
  tar --zstd -xf "$FETCHED/$file" -C "$STAGE" --strip-components=1 --no-same-owner ||
    die "Could not unpack the download into $STAGE. Is the disk full?"
  rm -rf "$FETCHED"
  local part
  for part in node_modules/electron/dist/electron node_modules/node-pty/build/Release/pty.node dist/index.html dist-electron/main.js scripts/vibeforge; do
    [[ -e "$STAGE/$part" ]] || die "The ready-made build has no $part, so it was not installed."
  done
  touch "$STAGE/$MARK"
}

# Builds the tag (or $BRANCH) from source into $STAGE: a clone, npm ci (node-pty is compiled for
# this computer) and a Vite build.
build_from_source() {
  local tag="$1" missing=()
  command -v git >/dev/null 2>&1 || missing+=(git)
  command -v make >/dev/null 2>&1 || missing+=(base-devel)
  command -v g++ >/dev/null 2>&1 || missing+=(base-devel)
  command -v python3 >/dev/null 2>&1 || missing+=(python)
  if ((${#missing[@]})); then
    local packages
    packages=$(printf '%s\n' "${missing[@]}" | sort -u | tr '\n' ' ')
    die "Building from source needs build tools. Install them with: sudo pacman -S --needed $packages"
  fi
  # Vite, which builds the app, needs Node 20.19+ or 22.12+.
  ((NODE_MAJOR > 22 || (NODE_MAJOR == 22 && NODE_MINOR >= 12) || (NODE_MAJOR == 20 && NODE_MINOR >= 19))) ||
    die "Building VibeForge needs Node 20.19+ or 22.12+ (found $(node --version)). Try: mise use -g node@lts"
  command -v npm >/dev/null 2>&1 || die "npm is missing next to node."

  # The copy from two updates ago goes first, so the disk holds two copies at most, not three.
  rm -rf "$PREVIOUS"
  if [[ -d "$DEST/.git" ]]; then
    # A copy of its history (copy-on-write where the disk can), so the installed copy isn't touched.
    mkdir -p "$STAGE"
    cp -a --reflink=auto "$DEST/.git" "$STAGE/.git"
    git -C "$STAGE" fetch --quiet --tags --force origin
  else
    step "Cloning VibeForge"
    mkdir -p "$(dirname "$DEST")"
    git clone --quiet "$REPO" "$STAGE"
  fi

  # The latest release (or the one asked for), or a branch when one was asked for. Without an
  # answer from GitHub, the newest version tag. Never main by accident: unreleased work only when
  # VIBEFORGE_BRANCH asks.
  local target="$tag"
  if [[ -n "$BRANCH" ]]; then
    git -C "$STAGE" fetch --quiet origin "$BRANCH"
    target="origin/$BRANCH"
  elif [[ -z "$target" ]] || ! git -C "$STAGE" rev-parse --quiet --verify "refs/tags/$target" >/dev/null; then
    [[ -z "$VERSION" ]] || die "There is no VibeForge release $target."
    target=$(git -C "$STAGE" tag --list 'v[0-9]*' --sort=-v:refname | head -n 1)
    [[ -n "$target" ]] && note "Could not ask GitHub for the latest release; using the newest tag, $target"
    [[ -n "$target" ]] || die "Could not find a VibeForge release. Set VIBEFORGE_BRANCH=main to install the main branch on purpose."
  fi
  git -C "$STAGE" checkout --quiet --force --detach "$target"
  touch "$STAGE/$MARK"

  cd "$STAGE"
  step "Installing dependencies (Electron and the terminal engine; the first run takes a minute)"
  npm ci --no-audit --no-fund --loglevel=error
  [[ -x node_modules/electron/dist/electron ]] || die "Electron's binary did not download. Check the network, then run this again."
  [[ -f node_modules/node-pty/build/Release/pty.node ]] || die "The terminal engine (node-pty) did not build. Check base-devel and python, then run this again."
  step "Building"
  npm run build --silent >/dev/null
  cd "$HOME"
}

main() {
  [[ "${1:-}" == "--uninstall" ]] && uninstall

  printf '\n  %s%sVibeForge%s %s— your coding agents, forged into one desk%s\n\n' "$bold" "$amber" "$reset" "$dim" "$reset"

  [[ "$(uname -s)" == "Linux" ]] || die "VibeForge is Linux-only. It is built for Omarchy."

  # The new copy goes beside the installed one, on the same disk, so the swap is a rename.
  DEST="$(realpath -m "$DEST")"
  [[ "$DEST" != "/" ]] || die "VIBEFORGE_HOME can't be /."
  PREVIOUS="$DEST.previous"
  # A git checkout is what this installer made before releases carried a ready-made build.
  if [[ -e "$DEST" && ! -d "$DEST/.git" && ! -e "$DEST/$MARK" ]]; then
    die "$DEST exists but is not a VibeForge copy. Move it aside or set VIBEFORGE_HOME."
  fi
  if [[ -z "$RELEASES" && "$REPO" =~ github\.com[/:]([^/]+)/([^/]+)$ ]]; then
    RELEASES="https://github.com/${BASH_REMATCH[1]}/${BASH_REMATCH[2]%.git}/releases"
  fi

  # Node usually comes from mise on Omarchy; make its shims visible to this script.
  export PATH="$HOME/.local/share/mise/shims:$BIN_DIR:$PATH"
  if ! command -v node >/dev/null 2>&1; then
    if command -v mise >/dev/null 2>&1; then
      step "Installing Node LTS with mise"
      mise use -g node@lts
    else
      die "Node.js is missing; VibeForge's terminals run on it. On Omarchy: mise use -g node@lts (or sudo pacman -S nodejs)"
    fi
  fi
  # The terminal host is what runs on this Node. node-pty's addon is built against Node-API, which
  # every Node from 20 on speaks, so the ready-made build doesn't care which one it is.
  read -r NODE_MAJOR NODE_MINOR < <(node -p 'process.versions.node.split(".").slice(0, 2).join(" ")')
  ((NODE_MAJOR >= 20)) || die "VibeForge needs Node 20 or newer (found $(node --version)). Try: mise use -g node@lts"

  # The release's ready-made build, unless something asks for source or there is none.
  local arch="" why="" tag=""
  case "$(uname -m)" in
    x86_64 | amd64) arch=x64 ;;
    aarch64 | arm64) arch=arm64 ;;
  esac
  if [[ -n "$BRANCH" ]]; then
    why="VIBEFORGE_BRANCH=$BRANCH follows a branch, and only releases are ready-made"
  else
    if [[ -n "$VERSION" ]]; then tag="v${VERSION#v}"; else tag=$(latest_release_tag); fi
    if [[ "${VIBEFORGE_FROM_SOURCE:-}" == 1 ]]; then
      why="VIBEFORGE_FROM_SOURCE=1"
    elif [[ -z "$arch" ]]; then
      why="there is no ready-made build for $(uname -m)"
    elif [[ -z "$tag" ]]; then
      why="could not ask GitHub which release is the latest"
    fi
  fi

  STAGE="$DEST.next"
  trap finish EXIT
  rm -rf "$STAGE"
  if [[ -e "$DEST" ]]; then step "Updating $DEST"; else step "Installing into $DEST"; fi
  if [[ -z "$why" ]]; then
    local missing=() tool
    for tool in curl tar zstd sha256sum; do
      command -v "$tool" >/dev/null 2>&1 || missing+=("$tool")
    done
    ((${#missing[@]} == 0)) || die "Missing ${missing[*]}. Install them with: sudo pacman -S --needed curl tar zstd coreutils"
    fetch_archive "$tag" "$arch"
    why="$NO_ARCHIVE"
  fi
  if [[ -n "$why" ]]; then
    step "Building from source: $why"
    build_from_source "$tag"
  fi
  local version
  version=$(node -p 'require(process.argv[1]).version' "$STAGE/package.json")
  [[ -n "$why" || "v$version" == "$tag" ]] || die "The ready-made build for $tag says it is $version, so it was not installed."

  # The swap. A VibeForge that is open keeps its files and carries on until it restarts.
  cd "$HOME"
  if [[ -e "$DEST" ]]; then
    rm -rf "$PREVIOUS"
    mv "$DEST" "$PREVIOUS"
  fi
  if ! mv "$STAGE" "$DEST"; then
    if [[ -e "$PREVIOUS" && ! -e "$DEST" ]]; then mv "$PREVIOUS" "$DEST"; fi
    die "Could not move the new copy into $DEST."
  fi
  SWAPPED=1

  step "Adding the vibeforge command and the launcher entry"
  mkdir -p "$BIN_DIR" "$APPS_DIR" "$ICON_DIR/512x512/apps" "$ICON_DIR/256x256/apps" "$ICON_DIR/scalable/apps"
  chmod +x "$DEST/scripts/vibeforge"
  ln -sfn "$DEST/scripts/vibeforge" "$BIN_DIR/vibeforge"
  cp "$DEST/resources/icon.png" "$ICON_DIR/512x512/apps/vibeforge.png"
  cp "$DEST/resources/icon.svg" "$ICON_DIR/scalable/apps/vibeforge.svg"
  if command -v rsvg-convert >/dev/null 2>&1; then
    rsvg-convert -w 256 -h 256 "$DEST/resources/icon.svg" -o "$ICON_DIR/256x256/apps/vibeforge.png"
  fi
  cat >"$APPS_DIR/vibeforge.desktop" <<EOF
[Desktop Entry]
Version=1.0
Type=Application
Name=VibeForge
GenericName=Agent desk
Comment=Your coding CLIs, agents, routines and tasks in one window
Exec=$BIN_DIR/vibeforge
TryExec=$BIN_DIR/vibeforge
Icon=$ICON_DIR/512x512/apps/vibeforge.png
Terminal=false
Categories=Development;
Keywords=AI;Agent;Terminal;Code;Claude;Codex;Grok;Antigravity;
StartupNotify=true
StartupWMClass=vibeforge
EOF
  command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "$APPS_DIR" >/dev/null 2>&1 || true

  # The CLIs VibeForge knows (seedEngines in src/core/engines.ts).
  local found=() cli
  for cli in claude codex grok cursor-agent agy opencode copilot kimi muse crush pi hermes; do
    command -v "$cli" >/dev/null 2>&1 && found+=("$cli")
  done

  printf '\n%s✓ VibeForge %s is installed.%s\n' "$ember" "$version" "$reset"
  if [[ -n "$why" ]]; then note "Built from source on this computer."; else note "From the release's ready-made build."; fi
  note "Open it from the app launcher (Super + Space), or run: vibeforge"
  if ((${#found[@]})); then
    note "CLIs found on PATH: ${found[*]}"
  else
    note "No coding CLIs found yet. Install one (Claude Code, Codex, Grok, …) and VibeForge picks it up."
  fi
  case ":$START_PATH:" in
    *":$BIN_DIR:"* | *":$BIN_DIR/:"*) ;;
    *) note "Add $BIN_DIR to your PATH to use the vibeforge command from a terminal." ;;
  esac
  printf '\n'
}

# Inside, standard input is /dev/null: under `curl … | bash` it is the rest of this script, which
# a prompt (mise's, once) would swallow.
main "$@" </dev/null
