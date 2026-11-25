#!/usr/bin/env bash
# Builds the Android home-screen widget (android-widget/) into android-widget/build/vibeforge-widget.apk.
# Needs the Android SDK (ANDROID_HOME, else ~/.local/share/android-sdk), Java 21 and gradle 8.11.1
# (found through mise). Not part of the app or its release (scripts/pack-release.mjs leaves it out).
#
#   VIBEFORGE_WIDGET_URL=https://desktop.tail1234.ts.net scripts/build-android-widget.sh
#
# The address is only what the setup screen starts with; it can stay in local.properties as
# vibeforge.defaultUrl instead. The release key is read from the properties file VIBEFORGE_WIDGET_SIGNING
# names, else ~/.local/share/vibeforge-signing/widget-signing.properties (see
# android-widget/app/build.gradle.kts); without one the APK is signed with this computer's debug key.
# The certificate it was signed with is printed at the end.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WIDGET_DIR="$ROOT/android-widget"
SDK_ROOT="${ANDROID_HOME:-$HOME/.local/share/android-sdk}"

if command -v mise >/dev/null 2>&1; then
  JAVA_FOUND="$(mise where java@temurin-21 2>/dev/null || true)"
  if [ -z "$JAVA_FOUND" ]; then
    JAVA_FOUND="$(find "$HOME/.local/share/mise/installs" -maxdepth 2 -type d -name '*21*' -path '*java*' 2>/dev/null | head -n 1 || true)"
  fi
  if [ -n "$JAVA_FOUND" ] && [ -d "$JAVA_FOUND" ]; then
    export JAVA_HOME="$JAVA_FOUND"
    export PATH="$JAVA_HOME/bin:$PATH"
  fi
  GRADLE_BASE="$(mise where gradle@8.11.1 2>/dev/null || true)"
  if [ -z "$GRADLE_BASE" ]; then
    GRADLE_BASE="$(find "$HOME/.local/share/mise/installs" -maxdepth 2 -type d -path '*gradle*' 2>/dev/null | sort -r | head -n 1 || true)"
  fi
  if [ -n "$GRADLE_BASE" ]; then
    if [ -d "$GRADLE_BASE/gradle-8.11.1/bin" ]; then
      export GRADLE_HOME="$GRADLE_BASE/gradle-8.11.1"
    else
      export GRADLE_HOME="$GRADLE_BASE"
    fi
    export PATH="$GRADLE_HOME/bin:$PATH"
  fi
fi

# local.properties (gitignored) gets this computer's SDK path. What else is in it stays as it is: the
# address a build starts with (vibeforge.defaultUrl) and the release signing key, if any (see
# android-widget/app/build.gradle.kts). No pairing code goes in: the widget pairs on the phone, and an
# old line holding one is taken out.
node -e '
const fs = require("fs");
const path = require("path");
const [sdkDir, widgetDir] = process.argv.slice(1);
const file = path.join(widgetDir, "local.properties");
let kept = [];
try {
  kept = fs.readFileSync(file, "utf8").split("\n").filter((line) => line.trim() && !/^\s*(sdk\.dir|vibeforge\.defaultToken)\s*=/.test(line));
} catch {}
fs.writeFileSync(file, [`sdk.dir=${sdkDir}`, ...kept].join("\n") + "\n", { mode: 0o600 });
' "$SDK_ROOT" "$WIDGET_DIR"

cd "$WIDGET_DIR"
gradle assembleRelease --no-daemon

# The APK stays in the build folder: it is installed on the phone on its own, never shipped in the app.
APK_SRC="$WIDGET_DIR/app/build/outputs/apk/release/app-release.apk"
APK_DST="$WIDGET_DIR/build/vibeforge-widget.apk"
mkdir -p "$(dirname "$APK_DST")"
cp -f "$APK_SRC" "$APK_DST"
ls -lh "$APK_DST"
APKSIGNER="$(ls -d "$SDK_ROOT"/build-tools/*/apksigner 2>/dev/null | sort -V | tail -n 1 || true)"
if [ -n "$APKSIGNER" ]; then
  "$APKSIGNER" verify --print-certs "$APK_DST" | grep -E "certificate (DN|SHA-256 digest)" || true
fi
echo "To put it on the phone: tailscale file cp \"$APK_DST\" <phone-name>:   (or adb install -r with the phone plugged in)"
