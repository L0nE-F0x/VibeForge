#!/usr/bin/env bash
# VibeForge installer for Omarchy (and other Arch + Hyprland setups).
#
#   curl -fsSL https://vibe-forge.net/install | bash
#
# Clones VibeForge into ~/.local/share/vibeforge-app, checks out the newest release, builds it,
# and adds a `vibeforge` command plus an app-launcher entry. Run it again (or use Update in the
# app) to update. VIBEFORGE_BRANCH=main follows a branch instead of releases. `--uninstall`
# removes the command, launcher entry and login entry but keeps your agents, routines and runs.
#
# An update builds beside the installed copy, in vibeforge-app.next, and swaps it in only once the
# build worked, so a dropped network or a failed build leaves the installed copy as it was. The
# copy it replaced stays in vibeforge-app.previous; to go back, quit VibeForge and swap the two.
#
# Everything runs from main(), called on the last line: a download cut off part-way runs nothing.
set -euo pipefail

REPO="${VIBEFORGE_REPO:-https://github.com/L0nE-F0x/VibeForge.git}"
BRANCH="${VIBEFORGE_BRANCH:-}"
DEST="${VIBEFORGE_HOME:-$HOME/.local/share/vibeforge-app}"
BIN_DIR="$HOME/.local/bin"
APPS_DIR="$HOME/.local/share/applications"
ICON_DIR="$HOME/.local/share/icons/hicolor"
# The entry Settings → Start at login writes (src/core/autostart.ts).
AUTOSTART="${XDG_CONFIG_HOME:-$HOME/.config}/autostart/vibeforge.desktop"
# The PATH this started with, before main() adds mise's shims and $BIN_DIR to it.
START_PATH="${PATH:-}"
STAGE=""
SWAPPED=0

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

# The tag on GitHub's latest release: the same one the app's Update checks for, so a stray tag
# that was never released can't win. Prints nothing if GitHub can't be asked.
latest_release_tag() {
  [[ "$REPO" =~ github\.com[/:]([^/]+)/([^/]+)$ ]] || return 0
  command -v curl >/dev/null 2>&1 || return 0
  curl -fsSL --max-time 10 "https://api.github.com/repos/${BASH_REMATCH[1]}/${BASH_REMATCH[2]%.git}/releases/latest" 2>/dev/null |
    node -e 'let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => { try { process.stdout.write(String(JSON.parse(s).tag_name || "")); } catch {} });' || true
}

# On the way out: a half-built copy is removed, and a failed update says the installed one is as it was.
finish() {
  local status=$?
  if [[ -n "$STAGE" && -e "$STAGE" ]]; then rm -rf "$STAGE"; fi
  if ((status != 0 && !SWAPPED)) && [[ -f "$DEST/dist-electron/main.js" ]]; then
    note "The installed copy in $DEST is unchanged."
  fi
  return "$status"
}

main() {
  [[ "${1:-}" == "--uninstall" ]] && uninstall

  printf '\n  %s%sVibeForge%s %s— your coding agents, forged into one desk%s\n\n' "$bold" "$amber" "$reset" "$dim" "$reset"

  [[ "$(uname -s)" == "Linux" ]] || die "VibeForge is Linux-only. It is built for Omarchy."

  # The new build goes beside the copy, on the same disk, so the swap is a rename.
  DEST="$(realpath -m "$DEST")"
  [[ "$DEST" != "/" ]] || die "VIBEFORGE_HOME can't be /."
  local previous="$DEST.previous"

  # Node usually comes from mise on Omarchy; make its shims visible to this script.
  export PATH="$HOME/.local/share/mise/shims:$BIN_DIR:$PATH"

  local missing=()
  command -v git >/dev/null 2>&1 || missing+=(git)
  command -v make >/dev/null 2>&1 || missing+=(base-devel)
  command -v g++ >/dev/null 2>&1 || missing+=(base-devel)
  command -v python3 >/dev/null 2>&1 || missing+=(python)
  if ((${#missing[@]})); then
    local packages
    packages=$(printf '%s\n' "${missing[@]}" | sort -u | tr '\n' ' ')
    die "Missing build tools. Install them with: sudo pacman -S --needed $packages"
  fi

  if ! command -v node >/dev/null 2>&1; then
    if command -v mise >/dev/null 2>&1; then
      step "Installing Node LTS with mise"
      mise use -g node@lts
    else
      die "Node.js is missing. On Omarchy: mise use -g node@lts (or sudo pacman -S nodejs npm)"
    fi
  fi
  # Vite, which builds the app, needs Node 20.19+ or 22.12+.
  local node_major node_minor
  read -r node_major node_minor < <(node -p 'process.versions.node.split(".").slice(0, 2).join(" ")')
  ((node_major > 22 || (node_major == 22 && node_minor >= 12) || (node_major == 20 && node_minor >= 19))) ||
    die "VibeForge needs Node 20.19+ or 22.12+ (found $(node --version)). Try: mise use -g node@lts"
  command -v npm >/dev/null 2>&1 || die "npm is missing next to node."

  STAGE="$DEST.next"
  trap finish EXIT
  rm -rf "$STAGE"
  if [[ -d "$DEST/.git" ]]; then
    step "Updating $DEST"
    # The copy from two updates ago goes first, so the disk holds two copies at most, not three.
    rm -rf "$previous"
    # A copy of its history (copy-on-write where the disk can), so the installed copy isn't touched.
    mkdir -p "$STAGE"
    cp -a --reflink=auto "$DEST/.git" "$STAGE/.git"
    git -C "$STAGE" fetch --quiet --tags --force origin
  elif [[ -e "$DEST" ]]; then
    die "$DEST exists but is not a VibeForge checkout. Move it aside or set VIBEFORGE_HOME."
  else
    step "Cloning VibeForge into $DEST"
    mkdir -p "$(dirname "$DEST")"
    git clone --quiet "$REPO" "$STAGE"
  fi

  # The latest release, or a branch when one was asked for. Without an answer from GitHub, the
  # newest version tag. Never main by accident: unreleased work only when VIBEFORGE_BRANCH asks.
  local target
  if [[ -n "$BRANCH" ]]; then
    git -C "$STAGE" fetch --quiet origin "$BRANCH"
    target="origin/$BRANCH"
  else
    target=$(latest_release_tag)
    if [[ -z "$target" ]] || ! git -C "$STAGE" rev-parse --quiet --verify "refs/tags/$target" >/dev/null; then
      target=$(git -C "$STAGE" tag --list 'v[0-9]*' --sort=-v:refname | head -n 1)
      [[ -n "$target" ]] && note "Could not ask GitHub for the latest release; using the newest tag, $target"
      [[ -n "$target" ]] || die "Could not find a VibeForge release. Set VIBEFORGE_BRANCH=main to install the main branch on purpose."
    fi
  fi
  git -C "$STAGE" checkout --quiet --force --detach "$target"
  # Lets the app know this copy is the installer's, so its Update button runs this script.
  touch "$STAGE/.vibeforge-installer"

  cd "$STAGE"
  local version
  version=$(node -p 'require("./package.json").version')
  step "Installing dependencies (Electron and the terminal engine; the first run takes a minute)"
  npm ci --no-audit --no-fund --loglevel=error
  [[ -x node_modules/electron/dist/electron ]] || die "Electron's binary did not download. Check the network, then run this again."
  [[ -f node_modules/node-pty/build/Release/pty.node ]] || die "The terminal engine (node-pty) did not build. Check base-devel and python, then run this again."
  step "Building"
  npm run build --silent >/dev/null

  # The swap. A VibeForge that is open keeps its files and carries on until it restarts.
  cd "$HOME"
  if [[ -e "$DEST" ]]; then
    rm -rf "$previous"
    mv "$DEST" "$previous"
  fi
  if ! mv "$STAGE" "$DEST"; then
    if [[ -e "$previous" && ! -e "$DEST" ]]; then mv "$previous" "$DEST"; fi
    die "Could not move the new build into $DEST."
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
