#!/usr/bin/env bash
# VibeForge installer for Omarchy (and other Arch + Hyprland setups).
#
#   curl -fsSL https://raw.githubusercontent.com/L0nE-F0x/VibeForge/main/scripts/install.sh | bash
#
# Clones VibeForge into ~/.local/share/vibeforge-app, builds it, and adds a `vibeforge`
# command plus an app-launcher entry. Run it again to update. `--uninstall` removes the
# command and launcher entry but keeps your agents, routines and runs.
set -euo pipefail

REPO="${VIBEFORGE_REPO:-https://github.com/L0nE-F0x/VibeForge.git}"
BRANCH="${VIBEFORGE_BRANCH:-main}"
DEST="${VIBEFORGE_HOME:-$HOME/.local/share/vibeforge-app}"
BIN_DIR="$HOME/.local/bin"
APPS_DIR="$HOME/.local/share/applications"
ICON_DIR="$HOME/.local/share/icons/hicolor"

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
  step "Removing the vibeforge command and launcher entry"
  rm -f "$BIN_DIR/vibeforge" "$APPS_DIR/vibeforge.desktop"
  rm -f "$ICON_DIR/512x512/apps/vibeforge.png" "$ICON_DIR/256x256/apps/vibeforge.png" "$ICON_DIR/scalable/apps/vibeforge.svg"
  command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "$APPS_DIR" >/dev/null 2>&1 || true
  note "The app itself is still in $DEST. Delete it with: rm -rf \"$DEST\""
  note "Your data is untouched: ~/.config/vibeforge and ~/.local/share/vibeforge"
  exit 0
}

[[ "${1:-}" == "--uninstall" ]] && uninstall

printf '\n  %s%sVibeForge%s %s— your coding agents, forged into one desk%s\n\n' "$bold" "$amber" "$reset" "$dim" "$reset"

[[ "$(uname -s)" == "Linux" ]] || die "VibeForge is Linux-only. It is built for Omarchy."

# Node usually comes from mise on Omarchy; make its shims visible to this script.
export PATH="$HOME/.local/share/mise/shims:$BIN_DIR:$PATH"

missing=()
command -v git >/dev/null 2>&1 || missing+=(git)
command -v make >/dev/null 2>&1 || missing+=(base-devel)
command -v g++ >/dev/null 2>&1 || missing+=(base-devel)
command -v python3 >/dev/null 2>&1 || missing+=(python)
if ((${#missing[@]})); then
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
node_major=$(node -p 'process.versions.node.split(".")[0]')
((node_major >= 20)) || die "VibeForge needs Node 20 or newer (found $(node --version)). Try: mise use -g node@lts"
command -v npm >/dev/null 2>&1 || die "npm is missing next to node."

if [[ -d "$DEST/.git" ]]; then
  step "Updating $DEST"
  git -C "$DEST" fetch --quiet origin "$BRANCH"
  git -C "$DEST" checkout --quiet "$BRANCH"
  git -C "$DEST" reset --quiet --hard "origin/$BRANCH"
elif [[ -e "$DEST" ]]; then
  die "$DEST exists but is not a VibeForge checkout. Move it aside or set VIBEFORGE_HOME."
else
  step "Cloning VibeForge into $DEST"
  mkdir -p "$(dirname "$DEST")"
  git clone --quiet --branch "$BRANCH" "$REPO" "$DEST"
fi

cd "$DEST"
step "Installing dependencies (Electron and the terminal engine; the first run takes a minute)"
npm ci --no-audit --no-fund --loglevel=error
step "Building"
npm run build --silent >/dev/null

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
Keywords=AI;Agent;Terminal;Code;Claude;Codex;Grok;
StartupNotify=true
StartupWMClass=vibeforge
EOF
command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "$APPS_DIR" >/dev/null 2>&1 || true

found=()
for cli in claude codex grok cursor-agent gemini opencode copilot crush kimi; do
  command -v "$cli" >/dev/null 2>&1 && found+=("$cli")
done

printf '\n%s✓ VibeForge is installed.%s\n' "$ember" "$reset"
note "Open it from the app launcher (Super + Space), or run: vibeforge"
if ((${#found[@]})); then
  note "CLIs found on PATH: ${found[*]}"
else
  note "No coding CLIs found yet. Install one (Claude Code, Codex, Grok, …) and VibeForge picks it up."
fi
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) note "Add $BIN_DIR to your PATH to use the vibeforge command from a terminal." ;;
esac
printf '\n'
