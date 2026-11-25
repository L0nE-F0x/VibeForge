#!/usr/bin/env bash
# Tries a release's files the way people meet them after they are published: an install of the
# last release before versioned installs (v3.7.2, installed by its own install.sh) updated by this
# install.sh, as its in-app Update does; Go back; updating again; an update after that, which
# downloads only the app; updates stopped part-way (killed outright during the download and
# during the unpacking, and stopped with SIGTERM); a fresh install; and `vibeforge --uninstall` and
# `--purge-app`. The installed copy's own smoke test runs after the steps that change what starts.
#
#   scripts/try-updates.sh <release-dir>
#
# <release-dir> is what scripts/build-release.sh made (scripts/pack-release.mjs's four archives).
# The later releases are made from it with only their version changed. Everything happens in a
# scratch home, over file:// and a local HTTP server: nothing outside the scratch folder is read
# or written, and the person's own VibeForge is never touched.
#
# VIBEFORGE_LEGACY_DIR is a folder holding v3.7.2's install.sh, SHA256SUMS and
# vibeforge-3.7.2-linux-<arch>.tar.zst; without it they are downloaded from GitHub. Either way they
# are checked against that release's SHA256SUMS. TRY_SMOKE=all runs the smoke test after every
# step, TRY_SMOKE=none after none. TRY_KEEP=1 keeps the scratch folder.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
out="$(realpath "${1:?usage: scripts/try-updates.sh <release-dir>}")"
smoke_mode="${TRY_SMOKE:-some}"
legacy_tag=v3.7.2

case "$(uname -m)" in
  x86_64 | amd64) arch=x64 ;;
  aarch64 | arm64) arch=arm64 ;;
  *) echo "No ready-made build for $(uname -m)." >&2; exit 1 ;;
esac
apps=("$out"/vibeforge-app-*-linux-"$arch".tar.zst)
[[ -f "${apps[0]}" ]] || { echo "✗ $out has no vibeforge-app-*-linux-$arch.tar.zst. Run scripts/build-release.sh first." >&2; exit 1; }
built="$(basename "${apps[0]}")"
built="${built#vibeforge-app-}"
built="${built%-linux-*}"

# Its real path: what a VibeForge started from the launcher has in its arguments.
scratch="$(cd "$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/vibeforge-updates.XXXXXX")" && pwd -P)"
server_pid=""
holders=()
cleanup() {
  local pid
  for pid in "${holders[@]}" $server_pid; do kill "$pid" 2>/dev/null || true; done
  if [[ "${TRY_KEEP:-}" == 1 ]]; then echo "Kept $scratch"; else rm -rf "$scratch"; fi
}
trap cleanup EXIT

rel="$scratch/releases"
H="$scratch/home"
DEST="$H/.local/share/vibeforge-app"
mkdir -p "$rel/download" "$H"
failures=0
sizes=()

step() { printf '\n\033[1m▸ %s\033[0m\n' "$*"; }
ok() { printf '  ✓ %s\n' "$*"; }
bad() {
  printf '  \033[31m✗ %s\033[0m\n' "$*"
  failures=$((failures + 1))
}
check() {
  local what="$1"
  shift
  if "$@"; then ok "$what"; else bad "$what"; fi
}
same() { [[ "$1" == "$2" ]]; }
version_in() { sed -n 's/^  "version": "\([^"]*\)".*/\1/p' "$1/package.json" | head -n 1; }
link_of() { readlink "$1" 2>/dev/null || true; }

# The person: only a home and a PATH, as build-release.sh installs.
as_person() { env -i HOME="$H" PATH="${PERSON_PATH:-$PATH}" "$@"; }

# Runs an installer as the person, its output in $scratch/last.log and on the screen.
LOG="$scratch/last.log"
install_with() {
  local status=0
  as_person VIBEFORGE_RELEASES="file://$rel" "$@" >"$LOG" 2>&1 || status=$?
  sed 's/^/    | /' "$LOG"
  return "$status"
}
downloaded() { sed -n 's/.*Downloaded \([0-9.]* MB\).*/\1/p' "$LOG" | tail -n 1; }

smoke() {
  local why="$1" app
  [[ "$smoke_mode" == none ]] && return 0
  [[ "$smoke_mode" == all || "${2:-}" == key ]] || return 0
  app="$DEST"
  if [[ -L "$DEST/current" ]]; then app="$(readlink -f "$DEST/current")"; fi
  printf '  · smoke test from %s (%s)\n' "$app" "$why"
  if env -i HOME="$H" PATH="$PATH" ${DISPLAY:+DISPLAY="$DISPLAY"} ${XAUTHORITY:+XAUTHORITY="$XAUTHORITY"} \
    ${SMOKE_HEADLESS:+SMOKE_HEADLESS="$SMOKE_HEADLESS"} ${SMOKE_PORT:+SMOKE_PORT="$SMOKE_PORT"} ${CI:+CI="$CI"} TMPDIR="${TMPDIR:-/tmp}" \
    node "$app/scripts/smoke.mjs" >"$scratch/smoke.log" 2>&1; then
    ok "the smoke test passes from the installed copy ($why)"
  else
    tail -n 30 "$scratch/smoke.log" | sed 's/^/    | /'
    bad "the smoke test failed from the installed copy ($why)"
  fi
}

# What the person keeps across all of this: settings, data, login entry, the voice keys.
data_sum() {
  (cd "$H" && find .config/vibeforge .local/share/vibeforge/runs .config/autostart .config/hypr -type f -print0 | LC_ALL=C sort -z | xargs -0 sha256sum) | sha256sum
}

# ------------------------------------------------------------------ the releases

step "The releases: $legacy_tag as published, and later ones made from $built"
legacy_file="vibeforge-${legacy_tag#v}-linux-$arch.tar.zst"
ldir="$rel/download/$legacy_tag"
mkdir -p "$ldir"
for file in install.sh SHA256SUMS "$legacy_file"; do
  if [[ -n "${VIBEFORGE_LEGACY_DIR:-}" ]]; then
    cp "$VIBEFORGE_LEGACY_DIR/$file" "$ldir/$file"
  else
    curl -fsSL --proto =https --proto-redir =https --retry 3 -o "$ldir/$file" "https://github.com/L0nE-F0x/VibeForge/releases/download/$legacy_tag/$file"
  fi
done
(cd "$ldir" && awk -v a="$legacy_file" '$2 == "install.sh" || $2 == a' SHA256SUMS | sha256sum --check --quiet) ||
  { echo "✗ $legacy_tag's files do not match its SHA256SUMS." >&2; exit 1; }
ok "$legacy_tag's install.sh and $legacy_file match its SHA256SUMS"
legacy_size="$(stat -c %s "$ldir/$legacy_file")"

# A release made from the one built here, as version $1: the same app with its version changed, and
# the same Electron and Syncthing archives.
make_release() {
  local v="$1" dir="$rel/download/v$1" tmp from="vibeforge-app-$built-linux-$arch" to="vibeforge-app-$1-linux-$arch"
  mkdir -p "$dir"
  tmp="$(mktemp -d "$scratch/make.XXXXXX")"
  tar --zstd -xf "$out/$from.tar.zst" -C "$tmp"
  mv "$tmp/$from" "$tmp/$to"
  sed -i "0,/\"version\": \"$built\"/s//\"version\": \"$v\"/" "$tmp/$to/package.json" "$tmp/$to/manifest.json"
  tar --sort=name --owner=0 --group=0 --numeric-owner --use-compress-program="zstd -19 --long=27 -T0 -q" -cf "$dir/$to.tar.zst" -C "$tmp" "$to"
  rm -rf "$tmp"
  for file in "$out"/electron-*-linux-"$arch".tar.zst "$out"/syncthing-*-linux-"$arch".tar.zst; do ln -sf "$file" "$dir/"; done
  cp "$root/scripts/install.sh" "$dir/install.sh"
  (cd "$dir" && sha256sum install.sh ./*.tar.zst | sed 's,  \./,  ,' >SHA256SUMS)
}
A="$built-try.1"
B="$built-try.2"
C="$built-try.3"
for v in "$A" "$B" "$C"; do make_release "$v"; done
app_size="$(stat -c %s "$rel/download/v$A/vibeforge-app-$A-linux-$arch.tar.zst")"
ok "made $A, $B and $C"

# ------------------------------------------------------------------ 3.7.2, the old layout

step "Installing $legacy_tag with its own install.sh: the old layout"
install_with VIBEFORGE_VERSION="$legacy_tag" bash "$ldir/install.sh" || bad "$legacy_tag's installer failed"
check "the app is straight in ~/.local/share/vibeforge-app" test -f "$DEST/dist-electron/main.js"
check "~/.local/bin/vibeforge links to its launcher" same "$(link_of "$H/.local/bin/vibeforge")" "$DEST/scripts/vibeforge"
desktop_before="$(cat "$H/.local/share/applications/vibeforge.desktop")"
# What a person using it has by now.
mkdir -p "$H/.config/vibeforge" "$H/.local/share/vibeforge/runs/r1" "$H/.local/share/vibeforge/bin" "$H/.config/autostart" "$H/.config/hypr"
printf 'theme: omarchy\nlanguage: en\n' >"$H/.config/vibeforge/settings.yaml"
printf 'final screen\n' >"$H/.local/share/vibeforge/runs/r1/screen.txt"
printf '[Desktop Entry]\nExec=%s --hidden\n' "$H/.local/bin/vibeforge" >"$H/.config/autostart/vibeforge.desktop"
printf '# VibeForge voice: hold to talk to one agent, from anywhere\nbind = SUPER ALT, V, exec, vibeforge --voice start\n' >"$H/.config/hypr/bindings.conf"
# The link 3.7.2 puts first on its terminals' PATH (electron/host-lifecycle.ts).
ln -s "$DEST/scripts/vibeforge" "$H/.local/share/vibeforge/bin/vibeforge"
data_before="$(data_sum)"
smoke "$legacy_tag, the old layout"

# The 3.7.2 window, still open while it updates: something running from the old layout's files.
bash -c 'exec -a "$0" sleep 900' "$DEST/node_modules/electron/dist/electron" &
legacy_holder=$!
holders+=("$legacy_holder")

# ------------------------------------------------------------------ update from 3.7.2

step "Updating $legacy_tag to $A the way its Update does: VIBEFORGE_HOME=<its folder>, this install.sh"
install_with VIBEFORGE_HOME="$DEST" VIBEFORGE_VERSION="v$A" bash "$rel/download/v$A/install.sh" || bad "the update failed"
check "current is $A" same "$(link_of "$DEST/current")" "versions/$A"
check "previous is $legacy_tag, moved into versions/" same "$(link_of "$DEST/previous")" "versions/${legacy_tag#v}"
check "$legacy_tag in versions/ is whole and says it is ${legacy_tag#v}" same "$(version_in "$DEST/versions/${legacy_tag#v}")" "${legacy_tag#v}"
check "~/.local/bin/vibeforge follows current" same "$(link_of "$H/.local/bin/vibeforge")" "$DEST/current/scripts/vibeforge"
check "the launcher entry is the same" same "$(cat "$H/.local/share/applications/vibeforge.desktop")" "$desktop_before"
check "settings, runs, the login entry and the voice keys are untouched" same "$(data_sum)" "$data_before"
check "the open $legacy_tag keeps its files where they were" test -f "$DEST/dist-electron/main.js" -a -f "$DEST/electron/pty-host.cjs"
check "its terminals' vibeforge command still works" test -x "$H/.local/share/vibeforge/bin/vibeforge"
check "$A links to the shared Electron and Syncthing" test -L "$DEST/versions/$A/node_modules/electron/dist" -a -L "$DEST/versions/$A/vendor/syncthing"
check "the old layout's spare copy is gone" test ! -e "$DEST.previous"
# Its Restart runs its own Electron again: that now starts the current version's launcher.
check "restarting the open $legacy_tag starts the current version's launcher" \
  same "$(as_person VIBEFORGE_LAUNCH=check "$DEST/node_modules/electron/dist/electron" "$DEST" --class=vibeforge --enable-wayland-ime)" current
relaunch_helper="$(as_person VIBEFORGE_LAUNCH=check "$DEST/node_modules/electron/dist/electron" --type=relauncher --- "$DEST" 2>/dev/null || true)"
check "Electron's relauncher helper does not route through the launcher" test "$relaunch_helper" != "current"
check "its Electron still runs as Node for what it spawns" \
  same "$(as_person ELECTRON_RUN_AS_NODE=1 "$DEST/node_modules/electron/dist/electron" -p 'process.type ?? "node"')" node
first_update="$(downloaded)"
sizes+=("$legacy_tag → $A (the first update, which moves the layout): ${first_update:-?}")
smoke "updated from $legacy_tag" key

# ------------------------------------------------------------------ go back

step "Go back: vibeforge --rollback"
install_with "$H/.local/bin/vibeforge" --rollback || bad "--rollback failed"
check "current is $legacy_tag again" same "$(link_of "$DEST/current")" "versions/${legacy_tag#v}"
check "previous is $A" same "$(link_of "$DEST/previous")" "versions/$A"
check "$legacy_tag's own Electron is back in place" test ! -e "$DEST/versions/${legacy_tag#v}/node_modules/electron/dist/electron.real"
check "settings and data are untouched" same "$(data_sum)" "$data_before"
smoke "gone back to $legacy_tag" key

# ------------------------------------------------------------------ update again

step "Updating again from $legacy_tag, which passes its own folder as VIBEFORGE_HOME"
install_with VIBEFORGE_HOME="$DEST/versions/${legacy_tag#v}" VIBEFORGE_VERSION="v$A" bash "$rel/download/v$A/install.sh" || bad "the update failed"
check "current is $A" same "$(link_of "$DEST/current")" "versions/$A"
check "nothing was downloaded: $A was still here" grep -q "is here already" "$LOG"
check "nothing was put inside $legacy_tag's folder" test ! -e "$DEST/versions/${legacy_tag#v}/versions"
sizes+=("$legacy_tag → $A again, after Go back: nothing")
smoke "updated again"

step "Updating $A to $B, while $legacy_tag still runs from versions/"
bash -c 'exec -a "$0" sleep 900' "$DEST/versions/${legacy_tag#v}/node_modules/electron/dist/electron.real" &
holders+=($!)
version_holder=$!
install_with VIBEFORGE_HOME="$DEST" VIBEFORGE_VERSION="v$B" bash "$rel/download/v$B/install.sh" || bad "the update failed"
check "current is $B, previous $A" same "$(link_of "$DEST/current") $(link_of "$DEST/previous")" "versions/$B versions/$A"
check "only the app was downloaded (Electron and Syncthing were here)" grep -q "were here already" "$LOG"
check "$legacy_tag is kept while something runs from it" test -d "$DEST/versions/${legacy_tag#v}"
sizes+=("$A → $B (same Electron and Syncthing): $(downloaded)")
smoke "updated to $B"

# ------------------------------------------------------------------ stopped part-way

# A server that sends about 300 KB a second, so a download takes long enough to be cut.
cat >"$scratch/slow.cjs" <<'EOF'
const fs = require("fs"), http = require("http"), path = require("path");
const root = process.argv[2];
http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  const file = path.join(root, path.normalize(decodeURIComponent(url.pathname)).replace(/^\/releases/, ""));
  fs.readFile(file, (error, data) => {
    if (error) { res.writeHead(404); return res.end("Not Found"); }
    res.writeHead(200, { "content-length": data.length });
    let at = 0;
    const next = () => { if (at >= data.length) return res.end(); res.write(data.subarray(at, at + 30000)); at += 30000; setTimeout(next, 100); };
    next();
  });
}).listen(0, "127.0.0.1", function () { console.log(this.address().port); });
EOF
node "$scratch/slow.cjs" "$rel" >"$scratch/port" &
server_pid=$!
for _ in $(seq 50); do [[ -s "$scratch/port" ]] && break; sleep 0.1; done
slow="http://127.0.0.1:$(cat "$scratch/port")/releases"

# Starts an update to $C in its own process group, waits for $1 in its output, then sends $2.
stop_update() {
  local when="$1" signal="$2" pid status=0
  shift 2
  setsid env -i HOME="$H" PATH="${TRY_PATH:-$PATH}" VIBEFORGE_RELEASES="$slow" VIBEFORGE_HOME="$DEST" VIBEFORGE_VERSION="v$C" VIBEFORGE_FORCE=1 \
    bash "$rel/download/v$C/install.sh" >"$LOG" 2>&1 &
  pid=$!
  for _ in $(seq 300); do grep -q "$when" "$LOG" 2>/dev/null && break; sleep 0.1; done
  sleep 0.5
  kill "-$signal" -- "-$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || status=$?
  sed 's/^/    | /' "$LOG"
  ((status != 0)) || bad "the update was not stopped ($when)"
}

still_b() {
  check "current is still $B" same "$(link_of "$DEST/current")" "versions/$B"
  check "$B is whole" test -f "$DEST/current/dist-electron/main.js" -a -x "$DEST/current/node_modules/electron/dist/electron"
  check "the vibeforge command still starts $B" same "$(as_person VIBEFORGE_LAUNCH=check "$H/.local/bin/vibeforge")" current
}

step "An update to $C killed outright (as by a power cut) during the download"
stop_update "Downloading VibeForge" KILL
still_b

step "An update to $C killed outright while it unpacks"
mkdir -p "$scratch/slow-tar"
cat >"$scratch/slow-tar/tar" <<EOF
#!/bin/sh
$(command -v tar) "\$@" || exit \$?
case " \$* " in *" -x"*) echo "unpacked" >&2; exec sleep 60 ;; esac
EOF
chmod +x "$scratch/slow-tar/tar"
TRY_PATH="$scratch/slow-tar:$PATH" stop_update "unpacked" KILL
still_b
check "what it left is only a stage, beside the versions" bash -c 'compgen -G "$0/versions/.stage-*" >/dev/null || compgen -G "$0/.download" >/dev/null' "$DEST"

# SIGTERM, as closing its terminal does: Ctrl+C runs the same trap, but a test's background job
# can't receive SIGINT (bash starts it ignored).
step "An update to $C stopped (SIGTERM) during the download"
stop_update "Downloading VibeForge" TERM
still_b
check "it tidied up after itself" bash -c '! compgen -G "$0/versions/.stage-[0-9]*" >/dev/null && test ! -e "$0/.download"' "$DEST"
smoke "after three stopped updates"

kill "$legacy_holder" "$version_holder" 2>/dev/null || true
wait "$legacy_holder" "$version_holder" 2>/dev/null || true

step "The update to $C, once nothing runs from the old files"
install_with VIBEFORGE_HOME="$DEST" VIBEFORGE_VERSION="v$C" bash "$rel/download/v$C/install.sh" || bad "the update failed"
check "current is $C, previous $B" same "$(link_of "$DEST/current") $(link_of "$DEST/previous")" "versions/$C versions/$B"
check "only current and previous are kept" same "$(cd "$DEST/versions" && ls -A | tr '\n' ' ')" "$B $C "
check "the old layout's files are gone" test ! -e "$DEST/dist-electron" -a ! -e "$DEST/node_modules"
check "one Electron and one Syncthing are kept" same "$(ls "$DEST/runtime" | wc -l)" 2
check "nothing a stopped update left is there" bash -c '! compgen -G "$0/versions/.stage-*" >/dev/null && ! compgen -G "$0/runtime/.stage-*" >/dev/null && test ! -e "$0/.download"' "$DEST"
check "settings and data are untouched" same "$(data_sum)" "$data_before"
smoke "updated to $C"

# ------------------------------------------------------------------ fresh

step "A fresh install of $B into an empty home"
H_MAIN="$H"
H="$scratch/fresh"
mkdir -p "$H"
FRESH_DEST="$H/.local/share/vibeforge-app"
# With a `node` that fails first on PATH: a ready-made install needs no Node.
mkdir -p "$scratch/no-node"
printf '#!/bin/sh\necho "the installer ran node" >&2\nexit 127\n' >"$scratch/no-node/node"
chmod +x "$scratch/no-node/node"
PERSON_PATH="$scratch/no-node:$PATH" install_with VIBEFORGE_VERSION="v$B" bash "$rel/download/v$B/install.sh" || bad "the fresh install failed"
check "it needed no Node" bash -c '! grep -q "the installer ran node" "$0"' "$LOG"
check "current is $B, and there is no previous" same "$(link_of "$FRESH_DEST/current") $(link_of "$FRESH_DEST/previous")" "versions/$B "
check "it downloaded the app, Electron and Syncthing" grep -q "Downloading Electron" "$LOG"
sizes+=("a fresh install: $(downloaded)")
saved_dest="$DEST"
DEST="$FRESH_DEST"
smoke "a fresh install" key
DEST="$saved_dest"
H="$H_MAIN"

# ------------------------------------------------------------------ uninstall

step "vibeforge --uninstall"
install_with "$H/.local/bin/vibeforge" --uninstall || bad "--uninstall failed"
check "the command, launcher entry and login entry are gone" test ! -e "$H/.local/bin/vibeforge" -a ! -e "$H/.local/share/applications/vibeforge.desktop" -a ! -e "$H/.config/autostart/vibeforge.desktop"
check "the app's folder stays" test -L "$DEST/current"
check "it names the four folders to delete for everything" grep -q "rm -rf ~/.config/vibeforge ~/.local/share/vibeforge ~/.config/VibeForge ~/.cache/vibeforge" "$LOG"
check "the settings stay" test -f "$H/.config/vibeforge/settings.yaml"

step "install.sh --purge-app, from the installed copy"
install_with bash "$DEST/current/scripts/install.sh" --purge-app || bad "--purge-app failed"
check "the app's folder is gone" test ! -e "$DEST" -a ! -e "$DEST.lock"
check "the settings and runs stay" test -f "$H/.config/vibeforge/settings.yaml" -a -f "$H/.local/share/vibeforge/runs/r1/screen.txt"

# ------------------------------------------------------------------ what it came to

step "Download sizes"
printf '  before: every update downloaded the whole build, %s for %s\n' "$(awk -v b="$legacy_size" 'BEGIN { printf "%.1f MB", b / 1e6 }')" "$legacy_file"
printf '  now: the app archive alone is %s\n' "$(awk -v b="$app_size" 'BEGIN { printf "%.1f MB", b / 1e6 }')"
for line in "${sizes[@]}"; do printf '  %s\n' "$line"; done

if ((failures)); then
  printf '\n\033[31m✗ %d check(s) failed.\033[0m\n' "$failures"
  exit 1
fi
printf '\n✓ Every update path works.\n'
