#!/usr/bin/env bash
# VibeForge installer for Omarchy (and other Arch + Hyprland setups).
#
#   curl -fsSL https://vibe-forge.net/install | bash
#   curl -fsSL https://vibe-forge.net/install | bash -s -- --uninstall    (or --purge-app, --rollback)
#
# Downloads the newest release's ready-made build into ~/.local/share/vibeforge-app, checks every
# file against the release's SHA256SUMS, and adds a `vibeforge` command plus an app-launcher entry.
# That takes curl, tar, zstd and sha256sum, which every Arch install has; Node is needed only to
# build from source. Nothing is compiled. Run it again (or use Update in the app) to update.
#
# The layout, in ~/.local/share/vibeforge-app (VIBEFORGE_HOME):
#
#   versions/<version>/     one release each: the app itself, about 6 MB
#   runtime/electron-…/     Electron (about 275 MB) and Syncthing (about 33 MB), shared by the
#   runtime/syncthing-…/    versions that use the same ones; a version links to them
#   current -> versions/…   the version that starts: ~/.local/bin/vibeforge is current/scripts/vibeforge
#   previous -> versions/…  the one before it, for --rollback (Go back in the app)
#
# A release is split the same way: vibeforge-app-<v>-linux-<arch>.tar.zst (about 2 MB), and
# electron-…-linux-<arch>.tar.zst and syncthing-…-linux-<arch>.tar.zst, which are downloaded only
# when this computer doesn't have that Electron or Syncthing yet. The app archive's manifest.json
# names them and the SHA-256 of what they unpack to (tree_hash), so a copy already here is used only
# when it is the same, file for file. A release without the split files is installed from its whole
# archive, vibeforge-<v>-linux-<arch>.tar.zst, as before.
#
# An update is unpacked (or built) into versions/.stage-…, and only once it is whole and written to
# disk does `current` switch to it, in one rename. So a dropped network, a bad download, a failed
# build, Ctrl+C or a power cut leaves the installed version as it was, and a VibeForge that is open
# keeps running from its own folder until it restarts. Versions other than current and previous are
# removed, except one that something still runs from. --rollback swaps current and previous. Run
# again while the newest release is already installed, it only puts the command and launcher entry
# back (VIBEFORGE_FORCE=1 downloads it again). Two installers at once can't run: the second one stops.
#
# An install from before this layout (the app straight in ~/.local/share/vibeforge-app) is moved
# into it first: its files are hard-linked into versions/<its version>, so nothing is copied and a
# VibeForge running from them keeps all its files until it quits; they go on a later run.
#
# It builds from source instead (git clone, npm ci and a Vite build, which need git, base-devel and
# python) when VIBEFORGE_FROM_SOURCE=1, when VIBEFORGE_BRANCH names a branch to follow
# (VIBEFORGE_BRANCH=main for unreleased work), when the release has no ready-made build (older ones
# don't) or none for this CPU. It says which way it went. VIBEFORGE_VERSION=vX.Y.Z installs that
# release instead of the newest. `--uninstall` removes the command, launcher entry and login entry
# while keeping the app folder, agents, routines and runs; `--purge-app` also removes the app folder
# in `$DEST` (keeping `~/.config/vibeforge` and `~/.local/share/vibeforge`).
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
# Lets the app know a copy is the installer's, so its Update button runs this script. It is in the
# install folder and in each version.
MARK=".vibeforge-installer"
# What the install folder holds in this layout. Anything else in it is an install from before
# versions/, which tidy_legacy removes once nothing runs from it: a new name here goes in this list.
LAYOUT=(versions runtime current previous .download "$MARK")
# The PATH this started with, before main() adds mise's shims and $BIN_DIR to it.
START_PATH="${PATH:-}"
# curl's protocol limits for $RELEASES (set_proto).
PROTO=()
STAGE=""
DOWNLOADS=""
SWITCHED=0
# The latest release's tag, from latest_release_tag.
LATEST_TAG=""
# The version installed now, for the closing lines.
VERSION_DONE=""
# Set by fetch_archive when the release has no ready-made build for this CPU.
NO_ARCHIVE=""
# What fetch_archive downloaded, in bytes, and what it found here already.
FETCHED_BYTES=0
REUSED=()
# Where ensure_runtime put the Electron or Syncthing it was asked for.
RUNTIME_DIR=""
# The libraries Electron needs that this system doesn't have (electron_libraries).
MISSING_LIBS=""
# $DEST as it was given, before normalize_dest made it a real path.
DEST_GIVEN=""

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

# Package-install command tailored to the Linux distribution running this script.
pkg_hint() {
  local kind="$1" extra="${2:-}"
  if command -v pacman >/dev/null 2>&1; then
    case "$kind" in
      curl) printf 'sudo pacman -S --needed curl' ;;
      runtime) printf 'sudo pacman -S --needed curl tar zstd coreutils' ;;
      build) printf 'sudo pacman -S --needed %s' "${extra:-git base-devel python}" ;;
      node) printf 'mise use -g node@lts (or sudo pacman -S nodejs)' ;;
    esac
  elif command -v apt-get >/dev/null 2>&1; then
    case "$kind" in
      curl) printf 'sudo apt-get install -y curl' ;;
      runtime) printf 'sudo apt-get install -y curl tar zstd coreutils' ;;
      build) printf 'sudo apt-get install -y git build-essential python3' ;;
      node) printf 'mise use -g node@lts (or sudo apt-get install -y nodejs)' ;;
    esac
  elif command -v dnf >/dev/null 2>&1; then
    case "$kind" in
      curl) printf 'sudo dnf install -y curl' ;;
      runtime) printf 'sudo dnf install -y curl tar zstd coreutils' ;;
      build) printf 'sudo dnf install -y git make gcc-c++ python3' ;;
      node) printf 'mise use -g node@lts (or sudo dnf install -y nodejs)' ;;
    esac
  elif command -v zypper >/dev/null 2>&1; then
    case "$kind" in
      curl) printf 'sudo zypper install -y curl' ;;
      runtime) printf 'sudo zypper install -y curl tar zstd coreutils' ;;
      build) printf 'sudo zypper install -y git make gcc-c++ python3' ;;
      node) printf 'mise use -g node@lts (or sudo zypper install -y nodejs22)' ;;
    esac
  else
    case "$kind" in
      curl) printf 'install curl with your package manager' ;;
      runtime) printf 'install curl, tar, zstd and coreutils with your package manager' ;;
      build) printf 'install git, make, g++ and python3 with your package manager' ;;
      node) printf 'mise use -g node@lts (or install Node.js 22.12+ with your package manager)' ;;
    esac
  fi
}

# The libraries Electron can't find on this system, in MISSING_LIBS: one missing (GTK, NSS, ALSA…)
# would install fine and then never start. Arch's names for them are the ones
# packaging/aur/PKGBUILD depends on.
electron_libraries() {
  MISSING_LIBS=""
  command -v ldd >/dev/null 2>&1 || return 0
  MISSING_LIBS="$(ldd "$1/node_modules/electron/dist/electron" 2>/dev/null | awk '/not found/ { print $1 }' | sort -u | tr '\n' ' ' || true)"
  MISSING_LIBS="${MISSING_LIBS% }"
}

libraries_hint() {
  if command -v pacman >/dev/null 2>&1; then
    printf 'sudo pacman -S --needed alsa-lib at-spi2-core gtk3 libdrm libxss mesa nss'
  else
    printf "install the packages that provide them with your distribution's package manager"
  fi
}

# ------------------------------------------------------------------ small helpers

# A string field from a JSON file VibeForge wrote (package.json, manifest.json): the first
# `"key": "value"`. Not a JSON parser; these files are machine-written, with the field at the top.
json_field() {
  [[ -f "$1" ]] || return 0
  { grep -o '"'"$2"'"[[:space:]]*:[[:space:]]*"[^"]*"' "$1" || true; } | head -n 1 | sed 's/^.*:[[:space:]]*"\(.*\)"$/\1/'
}

# The version in a copy's package.json, or nothing.
version_of() {
  local v
  v="$(json_field "$1/package.json" version)"
  if [[ "$v" =~ ^[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.+-]+)?$ ]]; then printf '%s' "$v"; fi
}

# Points the link $2 at $1 in one rename, so there is never a moment without it.
link_atomic() {
  local tmp="$2.new.$$"
  rm -f "$tmp"
  ln -sfn "$1" "$tmp"
  mv -Tf "$tmp" "$2"
}

# Makes what was written under $1 durable before a switch points at it.
flush() { sync -f "$1" 2>/dev/null || sync; }

# What a folder holds, as one SHA-256: each file's contents and path, which files are executable and
# where links point. Files named .vibeforge-* are the installer's own marks and are left out.
# scripts/pack-release.mjs runs this same function to write a release's manifest.json, so a copy of
# Electron or Syncthing already on this computer is used only when it is the same, file for file.
tree_hash() {
  (
    cd "$1" || exit 1
    {
      find . -type f ! -name '.vibeforge-*' -print0 | LC_ALL=C sort -z | xargs -0r sha256sum --
      find . -type f -perm -u+x ! -name '.vibeforge-*' -print0 | LC_ALL=C sort -z | tr '\0' '\n'
      find . -type l -printf '%p -> %l\n' | LC_ALL=C sort
    } | sha256sum | cut -d' ' -f1
  )
}

# Every running program's command line, as files, leaving out this script's own.
PROC_FILES=()
proc_files() {
  PROC_FILES=()
  local file
  for file in /proc/[0-9]*/cmdline; do
    [[ "$file" == "/proc/$$/cmdline" || "$file" == "/proc/$BASHPID/cmdline" ]] || PROC_FILES+=("$file")
  done
}

# $1 as each way of writing it: under the real $DEST, and under $DEST as it was given (through a
# link, such as a home folder that is one), since a program may have been started either way.
spellings() {
  printf '%s\n' "$1"
  if [[ -n "$DEST_GIVEN" && "$DEST_GIVEN" != "$DEST" && "$1" == "$DEST"* ]]; then printf '%s\n' "$DEST_GIVEN${1#"$DEST"}"; fi
}

# True while a running program was started from $1, a folder: it is one of its arguments, or a
# file in it is (Electron and its helpers, the terminal host). Such a folder is never removed.
in_use() {
  [[ -d /proc/self ]] || return 1
  proc_files
  ((${#PROC_FILES[@]})) || return 1
  grep -qsazxF -f - "${PROC_FILES[@]}" <<<"$(spellings "$1")" && return 0
  grep -qsazF -f - "${PROC_FILES[@]}" <<<"$(spellings "$1" | sed 's,$,/,')"
}

# The names in $DEST that belong to an install from before versions/ (the app itself, or a git
# checkout), one per line.
legacy_entries() {
  local entry name skip keep
  for entry in "$DEST"/* "$DEST"/.[!.]* "$DEST"/..?*; do
    [[ -e "$entry" || -L "$entry" ]] || continue
    name="${entry##*/}"
    skip=0
    for keep in "${LAYOUT[@]}"; do [[ "$name" == "$keep" ]] && skip=1; done
    [[ "$name" == current.new.* || "$name" == previous.new.* ]] && skip=1
    ((skip)) || printf '%s\n' "$name"
  done
}

# True while a VibeForge from before versions/ still runs from the files in $DEST itself.
legacy_in_use() {
  [[ -d /proc/self ]] || return 1
  proc_files
  ((${#PROC_FILES[@]})) || return 1
  grep -qsazxF -f - "${PROC_FILES[@]}" <<<"$(spellings "$DEST")" && return 0
  local args line base
  args="$(grep -hsazF -f - "${PROC_FILES[@]}" <<<"$(spellings "$DEST" | sed 's,$,/,')" | tr '\0' '\n')" || true
  while IFS= read -r line; do
    while IFS= read -r base; do
      [[ "$line" == *"$base/"* ]] || continue
      case "$line" in *"$base/versions/"* | *"$base/runtime/"* | *"$base/current/"* | *"$base/previous/"* | *"$base/.download"*) continue ;; esac
      return 0
    done < <(spellings "$DEST")
  done <<<"$args"
  return 1
}

# Where the links point, relative to $DEST ("versions/3.8.0"), or nothing.
current_rel() { if [[ -L "$DEST/current" ]]; then readlink "$DEST/current"; fi; }
previous_rel() { if [[ -L "$DEST/previous" ]]; then readlink "$DEST/previous"; fi; }

# $DEST as a real path. Given a version's folder (an app from before this layout passes its own
# folder as VIBEFORGE_HOME, and so does one that went back to it), the install folder above it.
normalize_dest() {
  DEST_GIVEN="${DEST%/}"
  DEST="$(realpath -m "$DEST")"
  local up
  up="$(dirname "$DEST")"
  if [[ "${up##*/}" == versions && -e "$(dirname "$up")/$MARK" ]]; then
    DEST="$(dirname "$up")"
    DEST_GIVEN="$(dirname "$(dirname "$DEST_GIVEN")")"
  fi
  [[ "$DEST" != "/" ]] || die "VIBEFORGE_HOME can't be /."
}

# One installer at a time: a second one would clear the first one's download and half-made copy.
take_lock() {
  mkdir -p "$(dirname "$DEST")"
  if command -v flock >/dev/null 2>&1; then
    exec 9>"$DEST.lock"
    flock -n 9 || die "Another VibeForge install or update is running. Let it finish, then run this again."
  fi
}

# Remote downloads must stay on HTTPS across redirects; tests and release builds use local fixtures.
set_proto() {
  PROTO=()
  if [[ "$RELEASES" != file://* && ! "$RELEASES" =~ ^http://(127\.0\.0\.1|localhost|\[::1\])([:/]|$) ]]; then
    PROTO=(--proto =https --proto-redir =https)
  fi
}

uninstall() {
  local purge="${1:-0}"
  normalize_dest
  if ((purge)) && [[ -e "$DEST" && ! -d "$DEST/.git" && ! -e "$DEST/$MARK" && ! -f "$DEST/dist-electron/main.js" ]]; then
    die "$DEST exists but is not a VibeForge copy. Refusing to remove it."
  fi
  if ((purge)); then
    step "Removing VibeForge app files, command, launcher entry and login entry"
  else
    step "Removing the vibeforge command, launcher entry and login entry"
  fi
  rm -f "$BIN_DIR/vibeforge" "$APPS_DIR/vibeforge.desktop" "$AUTOSTART"
  rm -f "$ICON_DIR/512x512/apps/vibeforge.png" "$ICON_DIR/256x256/apps/vibeforge.png" "$ICON_DIR/scalable/apps/vibeforge.svg"
  command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "$APPS_DIR" >/dev/null 2>&1 || true
  if ((purge)); then
    rm -rf "$DEST" "$DEST.previous" "$DEST.next" "$DEST.download" "$DEST.lock"
  fi
  # Nothing running is stopped: a VibeForge that is open keeps its terminals until it is quit.
  note "If VibeForge is open, quit it (its tray menu → Quit, or close the window)."
  if ((purge)); then
    note "Removed the app files in $DEST."
  else
    note "The app itself is still in $DEST. Re-run with --purge-app, or delete it with: rm -rf \"$DEST\" \"$DEST.lock\""
  fi
  note "Your data is untouched: ~/.config/vibeforge and ~/.local/share/vibeforge (agents, routines, runs)."
  note "Also left: ~/.config/VibeForge (the window's browser profile: the browser pane's sign-ins and cache)"
  note "and ~/.cache/vibeforge. To remove everything, delete those four folders too:"
  note "rm -rf ~/.config/vibeforge ~/.local/share/vibeforge ~/.config/VibeForge ~/.cache/vibeforge"
  local hypr="${XDG_CONFIG_HOME:-$HOME/.config}/hypr"
  if grep -qs -e "VibeForge voice" "$hypr"/*.conf "$hypr"/*.lua 2>/dev/null; then
    note "Settings → Voice added a hold-to-talk key to $hypr: remove the lines under \"VibeForge voice\"."
  fi
  exit 0
}

# The tag of the latest release in LATEST_TAG, from where <releases>/latest redirects: the same release
# the app's Update checks for, so a stray tag that was never released can't win. Empty when there are
# no releases to ask about, or none published yet. GitHub not answering, or answering with an error,
# stops here: building from source instead would need GitHub too, and would hide why.
latest_release_tag() {
  LATEST_TAG=""
  [[ -n "$RELEASES" ]] || return 0
  command -v curl >/dev/null 2>&1 || die "curl is missing. Install it with: $(pkg_hint curl)"
  local out status=0 code url body
  # The answer's body goes to a file of its own, not /dev/null: on Ubuntu 24.04 (curl 8.5) this check
  # failed with curl error 23 when its output was /dev/null and --retry was on.
  body="$(mktemp "${TMPDIR:-/tmp}/vibeforge-latest.XXXXXX")" || die "Couldn't make a temporary file in ${TMPDIR:-/tmp}."
  out=$(curl -sS "${PROTO[@]}" -o "$body" -w '%{http_code} %{redirect_url}' --retry 2 --connect-timeout 20 --max-time 60 "$RELEASES/latest") || status=$?
  rm -f "$body"
  ((status == 0)) || die "Could not reach GitHub to find the latest release (curl error $status). Check the network, then run this again."
  code="${out%% *}"
  url="${out#* }"
  case "$code" in
    3??) if [[ "$url" =~ /tag/([^/?#]+)$ ]]; then LATEST_TAG="${BASH_REMATCH[1]}"; fi ;;
    *) die "GitHub answered $code when asked for the latest release. Try again in a few minutes." ;;
  esac
}

# On the way out: a half-built or half-downloaded copy is removed, and a failed update says the
# installed one is as it was. A run that was killed outright leaves them for the next run to clear.
finish() {
  local status=$?
  if [[ -n "$STAGE" && -e "$STAGE" ]]; then rm -rf "$STAGE"; fi
  rm -rf "$DEST"/runtime/.stage-*-$$ 2>/dev/null || true
  if [[ -n "$DOWNLOADS" && -e "$DOWNLOADS" ]]; then rm -rf "$DOWNLOADS"; fi
  if ((status != 0 && !SWITCHED)) && whole "$DEST/current"; then
    note "The installed copy in $DEST/current (VibeForge $(version_of "$DEST/current")) is unchanged."
  fi
  if ((status != 0 && SWITCHED)); then
    printf '\033[31m✗ VibeForge %s is in %s, but adding the vibeforge command or the launcher entry failed. Run this again.\033[0m\n' "$VERSION_DONE" "$DEST/current" >&2
  fi
  return "$status"
}

# The parts a working copy can't do without.
REQUIRED_PARTS=(node_modules/electron/dist/electron node_modules/node-pty/build/Release/pty.node dist/index.html dist-electron/main.js scripts/vibeforge)

# Whether every part is in the copy at $1.
whole() {
  local part
  [[ -d "$1" ]] || return 1
  for part in "${REQUIRED_PARTS[@]}"; do [[ -e "$1/$part" ]] || return 1; done
}

# ------------------------------------------------------------------ versions and the switch

# An install from before versions/: the app (or a git checkout) straight in $DEST. Its files are
# hard-linked into versions/<its version> (copied where the disk can't link), `current` points at
# that, and the vibeforge command follows `current`. The files stay where they were too, so a
# VibeForge running from them keeps working; tidy_legacy removes them once nothing runs from them.
migrate_legacy() {
  [[ -L "$DEST/current" ]] && return 0
  [[ -f "$DEST/dist-electron/main.js" || -d "$DEST/.git" ]] || return 0
  local v name stage entry
  v="$(version_of "$DEST")"
  name="${v:-unknown}"
  step "Moving VibeForge ${v:-(unknown version)} into $DEST/versions/$name, beside the versions to come"
  mkdir -p "$DEST/versions"
  if ! { whole "$DEST/versions/$name" && [[ "$(version_of "$DEST/versions/$name")" == "$v" ]]; }; then
    # A move that stopped part-way left a stage, or a folder by that name that isn't this copy.
    stage="$DEST/versions/.stage-move"
    rm -rf "$stage" "${DEST:?}/versions/$name"
    mkdir -p "$stage"
    local linked=1
    while IFS= read -r entry; do
      cp -al "$DEST/$entry" "$stage/" 2>/dev/null || { linked=0; break; }
    done < <(legacy_entries)
    if ((!linked)); then
      rm -rf "$stage"
      mkdir -p "$stage"
      while IFS= read -r entry; do
        cp -a --reflink=auto "$DEST/$entry" "$stage/" || die "Could not copy $DEST/$entry into $stage. Is the disk full?"
      done < <(legacy_entries)
    fi
    [[ -e "$stage/$MARK" || -d "$stage/.git" ]] || touch "$stage/$MARK"
    flush "$stage"
    mv -T "$stage" "$DEST/versions/$name"
  fi
  touch "$DEST/$MARK"
  link_atomic "versions/$name" "$DEST/current"
  flush "$DEST"
  # The command and the launcher entry's target follow `current` from now on.
  if [[ -L "$BIN_DIR/vibeforge" ]]; then
    link_atomic "$DEST/current/scripts/vibeforge" "$BIN_DIR/vibeforge" 2>/dev/null || true
  fi
  # The copy the old layout kept beside the install (the update before last), and anything a
  # stopped update left: about 313 MB that nothing uses.
  local old
  for old in "$DEST.previous" "$DEST.next" "$DEST.download"; do
    if [[ -e "$old" ]] && ! in_use "$old"; then rm -rf "$old"; fi
  done
  tidy_electron
}

# A VibeForge restarts by running its own Electron again. One started from a copy with Electron
# inside it (an install from before versions/, one from a whole archive, one built from source)
# would come back as the same version after an update. So while such a copy isn't current, its
# `electron` is this small script, which starts the current version's launcher instead, and the
# real binary waits beside it as electron.real for when the copy is current again.
WRAPPER_TAG="# vibeforge-installer: restart into the current version"
wrapper_for() {
  printf '%s\n' '#!/usr/bin/env bash' "$WRAPPER_TAG"
  printf '# Put here by scripts/install.sh while %s is not the installed version.\n' "$1"
  printf 'root=%q\nself=%q\n' "$DEST" "$1"
  cat <<'EOF'
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
helper=0
for arg in "$@"; do
  case "$arg" in --type=*) helper=1; break ;; esac
done
if ((!helper)) && [[ -z "${ELECTRON_RUN_AS_NODE:-}" && -x "$root/current/scripts/vibeforge" && "$(readlink -f "$root/current")" != "$self" ]]; then
  args=()
  for arg in "$@"; do
    case "$arg" in "$self" | "$self/" | --class=vibeforge | --enable-wayland-ime) ;; *) args+=("$arg") ;; esac
  done
  exec "$root/current/scripts/vibeforge" "${args[@]}"
fi
exec "$here/electron.real" "$@"
EOF
}

is_wrapper() { [[ -f "$1" && ! -L "$1" ]] && (($(stat -c %s "$1") < 4096)) && grep -qsF "$WRAPPER_TAG" "$1"; }

# $1 is a copy; $2 is 1 when it is current.
tidy_copy_electron() {
  local copy="$1" dist="$1/node_modules/electron/dist"
  [[ -d "$dist" && ! -L "$dist" ]] || return 0
  if (($2)); then
    if [[ -e "$dist/electron.real" ]]; then mv -f "$dist/electron.real" "$dist/electron"; fi
    return 0
  fi
  [[ -e "$dist/electron" ]] || return 0
  is_wrapper "$dist/electron" && return 0
  ln -f "$dist/electron" "$dist/electron.real" 2>/dev/null || cp -a "$dist/electron" "$dist/electron.real"
  wrapper_for "$copy" >"$dist/.electron.new.$$"
  chmod 755 "$dist/.electron.new.$$"
  mv -f "$dist/.electron.new.$$" "$dist/electron"
}

tidy_electron() {
  local cur version_dir
  cur="$(realpath -m "$DEST/current")"
  # The old layout's own files, while they are still there, are never current.
  if [[ -f "$DEST/dist-electron/main.js" || -d "$DEST/.git" ]]; then tidy_copy_electron "$DEST" 0; fi
  for version_dir in "$DEST"/versions/*/; do
    version_dir="${version_dir%/}"
    [[ -d "$version_dir" ]] || continue
    if [[ "$version_dir" == "$cur" ]]; then tidy_copy_electron "$version_dir" 1; else tidy_copy_electron "$version_dir" 0; fi
  done
}

# The old layout's files in $DEST, once nothing runs from them (they are in versions/ too).
tidy_legacy() {
  [[ -L "$DEST/current" ]] || return 0
  local entries entry
  entries="$(legacy_entries)"
  [[ -n "$entries" ]] || return 0
  if legacy_in_use; then
    note "The VibeForge that is open still runs from the old layout's files in $DEST; they go on a later update, once it has restarted."
    return 0
  fi
  while IFS= read -r entry; do rm -rf "${DEST:?}/$entry"; done <<<"$entries"
}

# Everything but current and previous, and the Electron and Syncthing they don't use, unless
# something still runs from it. Also anything a killed run left behind.
cleanup() {
  local cur prev item keep=() used=() link
  cur="$(current_rel)"
  prev="$(previous_rel)"
  for item in "$DEST"/versions/.stage-* "$DEST"/runtime/.stage-*; do
    [[ -e "$item" ]] || continue
    [[ "$item" == "$STAGE" || "$item" == *-$$ ]] && continue
    rm -rf "$item"
  done
  for item in "$DEST"/versions/*/; do
    item="${item%/}"
    [[ -d "$item" ]] || continue
    case "versions/${item##*/}" in
      "$cur" | "$prev") keep+=("$item") ;;
      *)
        if in_use "$item"; then
          keep+=("$item")
          note "Keeping $item: something is still running from it."
        else
          rm -rf "$item"
        fi
        ;;
    esac
  done
  for item in "${keep[@]}"; do
    for link in "$item/node_modules/electron/dist" "$item/vendor/syncthing"; do
      if [[ -L "$link" ]]; then used+=("$(basename "$(readlink "$link")")"); fi
    done
  done
  for item in "$DEST"/runtime/*/; do
    item="${item%/}"
    [[ -d "$item" ]] || continue
    local wanted=0 name
    for name in "${used[@]}"; do [[ "$name" == "${item##*/}" ]] && wanted=1; done
    if ((!wanted)) && ! in_use "$item"; then rm -rf "$item"; fi
  done
  tidy_legacy
}

# Points current at versions/$1, and previous at the version that was current.
switch_to() {
  local target="versions/$1" old
  old="$(current_rel)"
  flush "$DEST/$target"
  if [[ -n "$old" && "$old" != "$target" ]]; then link_atomic "$old" "$DEST/previous"; fi
  link_atomic "$target" "$DEST/current"
  flush "$DEST"
  SWITCHED=1
  tidy_electron
}

# The folder name for a version: its number, or with +2, +3… when a folder by that name is current,
# previous or in use (VIBEFORGE_FORCE=1 installing the same version again).
folder_for() {
  local v="$1" name="$1" n=2
  while [[ -e "$DEST/versions/$name" ]]; do
    case "versions/$name" in
      "$(current_rel)" | "$(previous_rel)") ;;
      *) in_use "$DEST/versions/$name" || { rm -rf "${DEST:?}/versions/$name"; break; } ;;
    esac
    name="$v+$n"
    n=$((n + 1))
  done
  printf '%s' "$name"
}

# --rollback: current and previous change places. Nothing is downloaded.
rollback() {
  normalize_dest
  take_lock
  printf '\n  %s%sVibeForge%s %s— going back%s\n\n' "$bold" "$amber" "$reset" "$dim" "$reset"
  [[ -L "$DEST/current" ]] || die "VibeForge in $DEST keeps no earlier version to go back to yet. Updating keeps one."
  local cur prev from to
  cur="$(current_rel)"
  prev="$(previous_rel)"
  [[ -n "$prev" && "$prev" != "$cur" ]] || die "There is no earlier version of VibeForge to go back to in $DEST."
  whole "$DEST/$prev" || die "The earlier version in $DEST/$prev is not whole, so VibeForge stays as it is."
  from="$(version_of "$DEST/$cur")"
  to="$(version_of "$DEST/$prev")"
  step "Going back from VibeForge $from to $to"
  trap finish EXIT
  flush "$DEST/$prev"
  link_atomic "$cur" "$DEST/previous"
  link_atomic "$prev" "$DEST/current"
  flush "$DEST"
  SWITCHED=1
  VERSION_DONE="$to"
  tidy_electron
  add_launcher
  tidy_legacy
  printf '\n%s✓ VibeForge %s is the installed version again.%s\n' "$ember" "$to" "$reset"
  note "Restart VibeForge to use it. $from is kept: update, or run this with --rollback again, to return to it."
  printf '\n'
  exit 0
}

# ------------------------------------------------------------------ downloading

# The checksum SHA256SUMS lists for a file, or nothing.
sum_of() { awk -v f="$1" '$2 == f || $2 == "*" f { print $1; exit }' "$DOWNLOADS/SHA256SUMS"; }

# Downloads one of the release's files into $DOWNLOADS and checks it against SHA256SUMS.
download() {
  local tag="$1" file="$2" label="$3" expected actual
  expected="$(sum_of "$file")"
  [[ "$expected" =~ ^[0-9a-f]{64}$ ]] || die "$tag's SHA256SUMS has no checksum for $file, so nothing was installed."
  step "Downloading $label"
  # A progress bar in a terminal (the app's Update runs this in one), none in a log. A download
  # that stalls for a minute gives up instead of waiting forever.
  local progress=(-sS)
  [[ -t 2 ]] && progress=(--progress-bar)
  curl -fL "${PROTO[@]}" "${progress[@]}" --retry 2 --connect-timeout 20 --speed-limit 1024 --speed-time 60 -o "$DOWNLOADS/$file" "$RELEASES/download/$tag/$file" ||
    die "The download stopped part-way. Check the network, then run this again."
  actual=$(sha256sum "$DOWNLOADS/$file")
  actual="${actual%% *}"
  [[ "$actual" == "$expected" ]] ||
    die "The download does not match $tag's SHA256SUMS, so it was not installed. Run this again; if it keeps happening, open an issue on GitHub."
  FETCHED_BYTES=$((FETCHED_BYTES + $(stat -c %s "$DOWNLOADS/$file")))
}

# A size in MB, for people.
megabytes() { awk -v b="$1" 'BEGIN { printf "%.1f MB", b / 1e6 }'; }

# "electron-45.2.3-linux-x64" → "Electron 45.2.3".
runtime_label() {
  local kind="${1%%-*}" version="${1#*-}"
  version="${version%-linux-*}"
  case "$kind" in electron) kind=Electron ;; syncthing) kind=Syncthing ;; esac
  printf '%s %s' "$kind" "$version"
}

# The Electron or Syncthing ($1) named $2 whose files hash to $3, in runtime/, by RUNTIME_DIR: the
# one already here, the same files hard-linked from the current version's own copy, or downloaded.
ensure_runtime() {
  local kind="$1" name="$2" tree="$3" tag="$4" label dir stage own found
  [[ "$name" =~ ^(electron|syncthing)-[0-9A-Za-z.]+-linux-(x64|arm64)$ && "$tree" =~ ^[0-9a-f]{64}$ ]] ||
    die "The ready-made build's manifest.json names no usable $kind, so it was not installed."
  label="$(runtime_label "$name")"
  dir="$DEST/runtime/$name-${tree:0:12}"
  RUNTIME_DIR="$dir"
  mkdir -p "$DEST/runtime"
  if [[ -d "$dir" ]]; then
    if [[ "$(tree_hash "$dir")" == "$tree" ]]; then
      REUSED+=("$label")
      note "$label is here already and unchanged, so it is not downloaded again."
      return 0
    fi
    in_use "$dir" && die "The copy of $label in $dir has changed and VibeForge is running from it. Quit VibeForge, then run this again."
    rm -rf "$dir"
  fi
  stage="$DEST/runtime/.stage-$name-$$"
  rm -rf "$stage"
  # The installed version's own copy (an install from before runtime/ has one), when it is the same.
  case "$kind" in
    electron) own="$DEST/current/node_modules/electron/dist" ;;
    *) own="$DEST/current/vendor/syncthing" ;;
  esac
  found="$(realpath -m "$own")"
  if [[ -d "$found" && "$found" != "$DEST/runtime/"* && ! -e "$found/electron.real" ]] && [[ "$(tree_hash "$found")" == "$tree" ]]; then
    if cp -al "$found" "$stage" 2>/dev/null || { rm -rf "$stage" && cp -a --reflink=auto "$found" "$stage"; }; then
      flush "$stage"
      mv -T "$stage" "$dir"
      REUSED+=("$label")
      note "$label is here already and unchanged, so it is not downloaded again."
      return 0
    fi
    rm -rf "$stage"
  fi
  download "$tag" "$name.tar.zst" "$label"
  mkdir -p "$stage"
  tar --zstd -xf "$DOWNLOADS/$name.tar.zst" -C "$stage" --strip-components=1 --no-same-owner ||
    die "Could not unpack $label into $stage. Is the disk full?"
  rm -f "$DOWNLOADS/$name.tar.zst"
  [[ "$(tree_hash "$stage")" == "$tree" ]] ||
    die "The downloaded $label is not the one this version of VibeForge was built with, so it was not installed."
  flush "$stage"
  mv -T "$stage" "$dir"
}

# The release's ready-made build for this CPU, downloaded, checked against the release's SHA256SUMS
# and unpacked into $STAGE: the app, and the Electron and Syncthing it names unless they are here
# already. When the release has none, NO_ARCHIVE says why and nothing is unpacked.
fetch_archive() {
  local tag="$1" arch="$2" v="${1#v}" app whole_file file sum status=0 code
  app="vibeforge-app-$v-linux-$arch.tar.zst"
  whole_file="vibeforge-$v-linux-$arch.tar.zst"
  DOWNLOADS="$DEST/.download"
  rm -rf "$DOWNLOADS"
  mkdir -p "$DOWNLOADS"
  code=$(curl -sSL "${PROTO[@]}" --retry 2 --connect-timeout 20 --max-time 60 -o "$DOWNLOADS/SHA256SUMS" -w '%{http_code}' "$RELEASES/download/$tag/SHA256SUMS") || status=$?
  # Only "not found" means a release from before these builds: GitHub's 404, or a file:// path that
  # isn't there. Any other answer (a rate limit, GitHub having a bad moment) stops, rather than
  # quietly building from source for a minute or asking for build tools nobody needs.
  if ((status == 37)) || { ((status == 0)) && [[ "$code" == 404 ]]; }; then
    NO_ARCHIVE="the $tag release has no ready-made build"
    return 0
  fi
  ((status == 0)) || die "Could not download $tag's checksums (curl error $status). Check the network, then run this again."
  [[ "$code" == 2?? || "$code" == 000 ]] || die "GitHub answered $code for $tag's checksums. Try again in a few minutes."
  if [[ -z "$(sum_of "$app")" && -z "$(sum_of "$whole_file")" ]]; then
    NO_ARCHIVE="the $tag release has no ready-made build for linux-$arch"
    return 0
  fi
  for file in "$app" "$whole_file"; do
    sum="$(sum_of "$file")"
    [[ -z "$sum" || "$sum" =~ ^[0-9a-f]{64}$ ]] || die "$tag's SHA256SUMS does not read as checksums, so nothing was installed."
  done

  mkdir -p "$STAGE"
  if [[ -n "$(sum_of "$app")" ]]; then
    download "$tag" "$app" "VibeForge $v, ready-made for linux-$arch"
    note "It matches the release's SHA256SUMS."
    tar --zstd -xf "$DOWNLOADS/$app" -C "$STAGE" --strip-components=1 --no-same-owner ||
      die "Could not unpack the download into $STAGE. Is the disk full?"
    rm -f "$DOWNLOADS/$app"
    # Electron and Syncthing, linked by relative paths so the install folder can move as a whole.
    ensure_runtime electron "$(json_field "$STAGE/manifest.json" electron)" "$(json_field "$STAGE/manifest.json" electronTree)" "$tag"
    mkdir -p "$STAGE/node_modules/electron"
    rm -rf "$STAGE/node_modules/electron/dist"
    ln -s "../../../../runtime/${RUNTIME_DIR##*/}" "$STAGE/node_modules/electron/dist"
    ensure_runtime syncthing "$(json_field "$STAGE/manifest.json" syncthing)" "$(json_field "$STAGE/manifest.json" syncthingTree)" "$tag"
    mkdir -p "$STAGE/vendor"
    rm -rf "$STAGE/vendor/syncthing"
    ln -s "../../../runtime/${RUNTIME_DIR##*/}" "$STAGE/vendor/syncthing"
  else
    download "$tag" "$whole_file" "VibeForge $v, ready-made for linux-$arch"
    note "It matches the release's SHA256SUMS."
    tar --zstd -xf "$DOWNLOADS/$whole_file" -C "$STAGE" --strip-components=1 --no-same-owner ||
      die "Could not unpack the download into $STAGE. Is the disk full?"
    rm -f "$DOWNLOADS/$whole_file"
  fi
  rm -rf "$DOWNLOADS"
  local part
  for part in "${REQUIRED_PARTS[@]}"; do
    [[ -e "$STAGE/$part" ]] || die "The ready-made build has no $part, so it was not installed."
  done
  # The terminal engine's addon was built on the release runner's Linux. One that this system can't
  # load (an older glibc, musl) would install fine and then open no terminals: build it here instead.
  # It is loaded the way the terminal host loads it, on the version's own Electron as Node.
  local loaded
  if ! loaded=$(ELECTRON_RUN_AS_NODE=1 "$STAGE/node_modules/electron/dist/electron" -e 'try { require(process.argv[1]) } catch (error) { console.log(String(error.message).split("\n")[0]); process.exit(1) }' "$STAGE/node_modules/node-pty" 2>&1); then
    note "$loaded"
    rm -rf "$STAGE"
    NO_ARCHIVE="the ready-made terminal engine doesn't load on this system"
    return 0
  fi
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
    die "Building from source needs build tools. Install them with: $(pkg_hint build "$packages")"
  fi
  # Vite, TypeScript 7, and VibeForge's engines require Node 22.12+. Nothing installs it here: a
  # change to the person's global mise or system setup is theirs to make.
  command -v node >/dev/null 2>&1 || die "Building VibeForge from source needs Node 22.12+, and there is none on PATH. Try: $(pkg_hint node)"
  local NODE_MAJOR NODE_MINOR
  read -r NODE_MAJOR NODE_MINOR < <(node -p 'process.versions.node.split(".").slice(0, 2).join(" ")')
  ((NODE_MAJOR > 22 || (NODE_MAJOR == 22 && NODE_MINOR >= 12))) ||
    die "Building VibeForge needs Node 22.12+ (found $(node --version)). Try: mise use -g node@lts"
  command -v npm >/dev/null 2>&1 || die "npm is missing next to node."

  rm -rf "$STAGE"
  if [[ -d "$DEST/current/.git" ]]; then
    # A copy of its history (copy-on-write where the disk can), so the installed copy isn't touched.
    mkdir -p "$STAGE"
    cp -a --reflink=auto "$DEST/current/.git" "$STAGE/.git"
    git -C "$STAGE" fetch --quiet --tags --force origin
  else
    step "Cloning VibeForge"
    mkdir -p "$(dirname "$STAGE")"
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
  # The Syncthing workspace sync runs: the pinned release, checked against its SHA-256. The
  # ready-made build has it inside. Sync is off until turned on, so a failed download only means
  # Settings → Sync offers to fetch it then.
  if [[ -f scripts/fetch-syncthing.mjs ]]; then
    node scripts/fetch-syncthing.mjs --quiet || note "Could not fetch Syncthing for workspace sync; Settings → Sync can fetch it later."
  fi
  cd "$HOME"
}

# The vibeforge command, the app-launcher entry and its icons, for the version in $DEST/current. The
# command goes through `current`, so it always starts the installed version. An icon that can't be
# made is only a missing icon, never a failed install.
add_launcher() {
  step "Adding the vibeforge command and the launcher entry"
  local app="$DEST/current"
  mkdir -p "$BIN_DIR" "$APPS_DIR" "$ICON_DIR/512x512/apps" "$ICON_DIR/256x256/apps" "$ICON_DIR/scalable/apps"
  chmod +x "$app/scripts/vibeforge"
  link_atomic "$app/scripts/vibeforge" "$BIN_DIR/vibeforge"
  cp "$app/resources/icon.png" "$ICON_DIR/512x512/apps/vibeforge.png" || note "Could not copy the app icon; the launcher entry shows a generic one."
  cp "$app/resources/icon.svg" "$ICON_DIR/scalable/apps/vibeforge.svg" || true
  if command -v rsvg-convert >/dev/null 2>&1; then
    rsvg-convert -w 256 -h 256 "$app/resources/icon.svg" -o "$ICON_DIR/256x256/apps/vibeforge.png" 2>/dev/null || true
  fi
  local exec_cmd="$BIN_DIR/vibeforge"
  if [[ "$exec_cmd" == *[[:space:]]* || "$exec_cmd" == *[\"\'\\\$]* || "$exec_cmd" == *'`'* ]]; then
    local escaped="$exec_cmd"
    escaped="${escaped//\\/\\\\}"
    escaped="${escaped//\"/\\\"}"
    escaped="${escaped//\$/\\\$}"
    escaped="${escaped//\`/\\\`}"
    exec_cmd="\"$escaped\""
  fi
  cat >"$APPS_DIR/vibeforge.desktop" <<EOF
[Desktop Entry]
Version=1.0
Type=Application
Name=VibeForge
GenericName=Agent desk
Comment=Your coding CLIs, agents, routines and tasks in one window
Exec=$exec_cmd
TryExec=$BIN_DIR/vibeforge
Icon=$ICON_DIR/512x512/apps/vibeforge.png
Terminal=false
Categories=Development;
Keywords=AI;Agent;Terminal;Code;Claude;Codex;Grok;Antigravity;
StartupNotify=true
StartupWMClass=vibeforge
EOF
  command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "$APPS_DIR" >/dev/null 2>&1 || true
}

usage() {
  cat <<'EOF'
VibeForge's installer. With no option, it installs VibeForge or updates it to the newest release.

  --rollback     go back to the version installed before this one (Go back in Settings → Updates)
  --uninstall    remove the vibeforge command, the launcher entry and Start at login
  --purge-app    the same, and remove the app's folder too (your data stays)

Piped from curl, options go after `bash -s --`:
  curl -fsSL https://vibe-forge.net/install | bash -s -- --uninstall
EOF
  exit 0
}

main() {
  case "${1:-}" in
    --uninstall) uninstall 0 ;;
    --purge-app) uninstall 1 ;;
    --rollback) rollback ;;
    -h | --help) usage ;;
    "") ;;
    *) die "Unknown option $1. Try --help." ;;
  esac

  printf '\n  %s%sVibeForge%s %s— your coding agents, forged into one desk%s\n\n' "$bold" "$amber" "$reset" "$dim" "$reset"

  [[ "$(uname -s)" == "Linux" ]] || die "VibeForge is Linux-only. It is built for Omarchy."

  normalize_dest
  # A git checkout is what this installer made before releases carried a ready-made build.
  if [[ -e "$DEST" && ! -d "$DEST/.git" && ! -e "$DEST/$MARK" ]]; then
    die "$DEST exists but is not a VibeForge copy. Move it aside or set VIBEFORGE_HOME."
  fi
  take_lock
  if [[ -z "$RELEASES" && "$REPO" =~ github\.com[/:]([^/]+)/([^/]+)$ ]]; then
    RELEASES="https://github.com/${BASH_REMATCH[1]}/${BASH_REMATCH[2]%.git}/releases"
  fi
  set_proto

  # A ready-made build needs no Node: the terminal host runs on Electron's own. Only a build from
  # source does (build_from_source checks), and Node usually comes from mise on Omarchy.
  export PATH="$HOME/.local/share/mise/shims:$BIN_DIR:$PATH"

  # The release's ready-made build, unless something asks for source or there is none.
  local arch="" why="" tag=""
  case "$(uname -m)" in
    x86_64 | amd64) arch=x64 ;;
    aarch64 | arm64) arch=arm64 ;;
  esac
  if [[ -n "$BRANCH" ]]; then
    why="VIBEFORGE_BRANCH=$BRANCH follows a branch, and only releases are ready-made"
  else
    if [[ -n "$VERSION" ]]; then
      tag="v${VERSION#v}"
    else
      latest_release_tag
      tag="$LATEST_TAG"
    fi
    if [[ "${VIBEFORGE_FROM_SOURCE:-}" == 1 ]]; then
      why="VIBEFORGE_FROM_SOURCE=1"
    elif [[ -z "$arch" ]]; then
      why="there is no ready-made build for $(uname -m)"
    elif [[ -z "$tag" && -z "$RELEASES" ]]; then
      why="$REPO has no GitHub releases to download from"
    elif [[ -z "$tag" ]]; then
      why="no release has been published yet"
    fi
  fi

  trap finish EXIT
  # Ctrl+C or a closed terminal still runs finish, which tidies up.
  trap 'exit 130' INT
  trap 'exit 143' TERM
  trap 'exit 129' HUP
  cd "$HOME"
  local fresh=1
  if [[ -e "$DEST/current" || -f "$DEST/dist-electron/main.js" || -d "$DEST/.git" ]]; then fresh=0; fi
  migrate_legacy
  cleanup

  local wanted="${tag#v}" forced=0
  if [[ "${VIBEFORGE_FORCE:-}" == 1 || "${VIBEFORGE_FROM_SOURCE:-}" == 1 ]]; then forced=1; fi
  # The release asked for is the one installed already: nothing to download, only the command and
  # the launcher entry put back (they may be what someone ran this again for).
  if [[ -z "$BRANCH" && -n "$tag" ]] && ((!forced)) && whole "$DEST/current" && [[ "$(version_of "$DEST/current")" == "$wanted" ]]; then
    VERSION_DONE="$wanted"
    step "VibeForge $VERSION_DONE is installed already, in $DEST"
    note "Nothing to download. VIBEFORGE_FORCE=1 installs it again."
    SWITCHED=1
    add_launcher
    say_done "already"
    return 0
  fi
  # It is here from before (the version someone went back from): switch to it, nothing to download.
  if [[ -z "$BRANCH" && -n "$tag" ]] && ((!forced)) && whole "$DEST/versions/$wanted" && [[ "$(version_of "$DEST/versions/$wanted")" == "$wanted" ]]; then
    step "VibeForge $wanted is here already, in $DEST/versions/$wanted; switching to it"
    note "Nothing to download. VIBEFORGE_FORCE=1 downloads it again."
    switch_to "$wanted"
    VERSION_DONE="$wanted"
    add_launcher
    cleanup
    say_done "already"
    return 0
  fi

  mkdir -p "$DEST/versions"
  touch "$DEST/$MARK"
  STAGE="$DEST/versions/.stage-$$"
  rm -rf "$STAGE"
  if ((fresh)); then step "Installing into $DEST"; else step "Updating $DEST"; fi
  if [[ -z "$why" ]]; then
    local missing=() tool
    for tool in curl tar zstd sha256sum; do
      command -v "$tool" >/dev/null 2>&1 || missing+=("$tool")
    done
    ((${#missing[@]} == 0)) || die "Missing ${missing[*]}. Install them with: $(pkg_hint runtime)"
    fetch_archive "$tag" "$arch"
    why="$NO_ARCHIVE"
  fi
  if [[ -n "$why" ]]; then
    step "Building from source: $why"
    build_from_source "$tag"
  fi
  local version name
  version="$(version_of "$STAGE")"
  [[ -n "$version" ]] || die "The new copy has no version in its package.json, so it was not installed."
  [[ -n "$why" || "v$version" == "$tag" ]] || die "The ready-made build for $tag says it is $version, so it was not installed."

  electron_libraries "$STAGE"

  # The switch. A VibeForge that is open keeps running from its own folder until it restarts.
  name="$(folder_for "$version")"
  flush "$STAGE"
  mv -T "$STAGE" "$DEST/versions/$name" || die "Could not move the new copy into $DEST/versions/$name."
  STAGE=""
  switch_to "$name"
  VERSION_DONE="$version"

  add_launcher
  cleanup
  if [[ -n "$why" ]]; then say_done "source"; else say_done "ready-made"; fi
}

# The closing lines: what is installed, how it got here, and where to start. $1 is "ready-made",
# "source" or "already".
say_done() {
  # The CLIs VibeForge knows (seedEngines in src/core/engines.ts).
  local found=() cli prev
  for cli in claude codex grok cursor-agent agy opencode copilot kimi muse crush pi hermes; do
    command -v "$cli" >/dev/null 2>&1 && found+=("$cli")
  done

  printf '\n%s✓ VibeForge %s is installed.%s\n' "$ember" "$VERSION_DONE" "$reset"
  case "$1" in
    source) note "Built from source on this computer." ;;
    ready-made)
      note "From the release's ready-made build."
      if ((${#REUSED[@]})); then
        note "Downloaded $(megabytes "$FETCHED_BYTES"); $(printf '%s and ' "${REUSED[@]}" | sed 's/ and $//') were here already."
      else
        note "Downloaded $(megabytes "$FETCHED_BYTES")."
      fi
      ;;
  esac
  if [[ -n "$MISSING_LIBS" ]]; then
    printf '%s! Electron needs libraries this system is missing, so VibeForge will not start until they are installed: %s%s\n' "$amber" "$MISSING_LIBS" "$reset"
    note "Install them with: $(libraries_hint)"
  fi
  prev="$(previous_rel)"
  if [[ "$1" != already && -n "$prev" ]] && whole "$DEST/$prev"; then
    note "VibeForge $(version_of "$DEST/$prev") is kept: Settings → Updates → Go back, or run this with --rollback, returns to it."
  fi
  if [[ -d "${XDG_CONFIG_HOME:-$HOME/.config}/omarchy" ]]; then
    note "Open it from the app launcher (Super + Space), or run: vibeforge"
  else
    note "Open it from your app launcher, or run: vibeforge"
  fi
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
