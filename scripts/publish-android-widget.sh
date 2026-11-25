#!/usr/bin/env bash
# Builds the Android widget signed with its release key and adds it to a GitHub release, as
# vibeforge-widget.apk with vibeforge-widget.apk.sha256 beside it (docs/phone-widget.md). The key stays
# on this computer: only the signed APK goes up. The website links
# https://github.com/L0nE-F0x/VibeForge/releases/latest/download/vibeforge-widget.apk, and release.yml
# carries the APK on to each later release, so give the latest release's tag.
#
#   scripts/publish-android-widget.sh v3.7.0              build, check, upload
#   scripts/publish-android-widget.sh v3.7.0 --no-upload  build and check only
#
# It stops before uploading when the APK is signed with anything but the widget's release key (its
# certificate's SHA-256 is below): a phone only installs an update over the widget when both are
# signed with the same key, so one signed with a debug key would strand everyone who installed it.
set -euo pipefail

RELEASE_CERT_SHA256="08ed1b36762ccf3347c2bc86232b353e7af9d6a00ada0b4253d5618aab7ffc16"
REPO="L0nE-F0x/VibeForge"

TAG="${1:-}"
UPLOAD=1
if [ "${2:-}" = "--no-upload" ]; then UPLOAD=0; elif [ -n "${2:-}" ]; then echo "Unknown option: $2" >&2; exit 2; fi
if ! [[ "$TAG" =~ ^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$ ]]; then
  echo "Usage: $0 <tag, like v3.7.0> [--no-upload]" >&2
  exit 2
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SDK_ROOT="${ANDROID_HOME:-$HOME/.local/share/android-sdk}"
# apksigner runs on Java: the same Java 21 the build finds through mise, when java isn't on PATH already.
if ! java -version >/dev/null 2>&1 && command -v mise >/dev/null 2>&1; then
  JAVA_FOUND="$(mise where java@temurin-21 2>/dev/null || true)"
  if [ -n "$JAVA_FOUND" ] && [ -d "$JAVA_FOUND" ]; then
    export JAVA_HOME="$JAVA_FOUND"
    export PATH="$JAVA_HOME/bin:$PATH"
  fi
fi
APKSIGNER="$SDK_ROOT/build-tools/34.0.0/apksigner"
[ -x "$APKSIGNER" ] || APKSIGNER="$(ls -d "$SDK_ROOT"/build-tools/*/apksigner 2>/dev/null | sort -V | tail -n 1 || true)"
if [ -z "$APKSIGNER" ] || [ ! -x "$APKSIGNER" ]; then
  echo "apksigner not found under $SDK_ROOT/build-tools: can't check the signature, so nothing is published." >&2
  exit 1
fi

if [ "$UPLOAD" = 1 ]; then
  gh release view "$TAG" --repo "$REPO" --json tagName >/dev/null || { echo "There is no release $TAG on $REPO." >&2; exit 1; }
fi

# A build for everyone: no address of this computer's tailnet baked in (android-widget/app/build.gradle.kts).
VIBEFORGE_WIDGET_PUBLIC=1 "$ROOT/scripts/build-android-widget.sh"

OUT="$ROOT/android-widget/build"
APK="$OUT/vibeforge-widget.apk"
certs="$("$APKSIGNER" verify --print-certs "$APK")"
signers="$(grep -c '^Signer #[0-9]* certificate SHA-256 digest:' <<<"$certs" || true)"
digest="$(sed -n 's/^Signer #1 certificate SHA-256 digest: *//p' <<<"$certs" | tr -d ': ' | tr '[:upper:]' '[:lower:]')"
if [ "$signers" != 1 ] || [ "$digest" != "$RELEASE_CERT_SHA256" ]; then
  echo "The APK is not signed with the widget's release key (certificate $digest), so nothing is published." >&2
  echo "Is the signing file there (VIBEFORGE_WIDGET_SIGNING, else ~/.local/share/vibeforge-signing/widget-signing.properties)?" >&2
  exit 1
fi
echo "Signed with the widget's release key (certificate SHA-256 $digest)."

(cd "$OUT" && sha256sum vibeforge-widget.apk > vibeforge-widget.apk.sha256 && sha256sum --check vibeforge-widget.apk.sha256)
cat "$OUT/vibeforge-widget.apk.sha256"

if [ "$UPLOAD" = 0 ]; then
  echo "Checked, not uploaded: $APK"
  exit 0
fi
(cd "$OUT" && gh release upload "$TAG" vibeforge-widget.apk vibeforge-widget.apk.sha256 --repo "$REPO" --clobber)
echo "Uploaded to $TAG: https://github.com/$REPO/releases/download/$TAG/vibeforge-widget.apk"
