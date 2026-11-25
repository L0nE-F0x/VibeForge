# The Android widget

A home-screen widget for Android phones that shows what VibeForge is doing on your computer. It is a separate app (an APK file) that you download and install yourself. It is not in the Play Store, and it is not part of the desktop app.

## What it does

The widget is a one-row bar. It shows how many coding CLIs are waiting for you or working, the busiest plan limit, and whether Viby has a plan waiting for Go. Tap ▾ and a tray opens with:

- each running session, with a peek at its screen and the nudges from Settings → Phone, or your own words, to send it
- the plan Viby has waiting, with **Go** and **Cancel** (each takes a second tap to confirm)
- your plan limits

Tapping a session, the waiting plan or Viby opens the phone page at that place. If the widget holds more than one computer, you can switch between them in the tray.

It only shows what the phone page shows, and only while it can reach your computer.

## What you need

- VibeForge running on your computer with **Settings → Phone** turned on. The computer has to stay on and awake.
- Your phone able to reach the phone page, usually with [Tailscale](https://tailscale.com) on both, as Settings → Phone sets up. If the phone page opens on your phone, the widget will work too.
- Android 9 or newer.

## Download and check it

Download it from https://vibe-forge.net/widget.apk, which leads to the newest widget release on GitHub. The widget has releases of its own, named `widget-vX.Y.Z` and kept apart from the app's `vX.Y.Z` ones: [all releases](https://github.com/L0nE-F0x/VibeForge/releases).

Beside the APK is `vibeforge-widget.apk.sha256` (also at https://vibe-forge.net/widget.apk.sha256). To check that the file is the one published, compare its SHA-256 with that file. On a computer:

```sh
sha256sum --check vibeforge-widget.apk.sha256
```

It should print `vibeforge-widget.apk: OK`. On the phone, a file manager or checksum app that shows SHA-256 does the same: the two values must match exactly.

Every build is signed with the same key. Its certificate's SHA-256 is:

```
08:ED:1B:36:76:2C:CF:33:47:C2:BC:86:23:2B:35:3E:7A:F9:D6:A0:0A:DA:0B:42:53:D5:61:8A:AB:7F:FC:16
```

With the Android SDK, `apksigner verify --print-certs vibeforge-widget.apk` shows it.

## Install it

1. Open the downloaded file on the phone.
2. Android asks you to allow your browser (or file manager) to **install unknown apps**. Allow it for that app. You can turn it off again afterwards in the phone's settings.
3. Google Play Protect may warn that it doesn't know this app, because it isn't from the Play Store. If you checked the file as above, choose to install anyway.
4. Long-press an empty spot on your home screen, choose **Widgets**, and add **VibeForge Dashboard** (under VibeForge Widget). The setup screen opens.

## Pair it

Scan the QR code. Nothing to type.

1. On your computer, open **Settings → Phone** and tap **Show QR code** (beside the address, under "Open it on your phone").
2. In the widget's setup screen, tap **Scan the QR code**. The first time, Android asks to let the widget use the camera: allow it.
3. Point the phone at the QR code. The widget reads it, says which computer it found and pairs straight away.

The camera is only asked for when you tap Scan. The code is read on the phone itself, without Google Play Services, so it works on phones without Google too, and the picture never leaves the phone. A QR code that isn't a VibeForge pairing link is refused: the widget says so and keeps looking, and sends nothing anywhere.

**Typing it in instead.** If you'd rather not use the camera, or the phone has none, tap **Type the address and code instead**:

1. Type your computer's address (its Tailscale name, like `desktop`, or the whole address) and the pairing code from **Settings → Phone** on that computer. You can also copy the pairing link there and tap **Paste pairing link**.
2. Tap **Pair & show this computer**.

If you said no to the camera, the setup screen offers typing. To scan after all, tap Scan again; if Android no longer asks, turn the camera on in the phone's **Settings → Apps → VibeForge Widget → Permissions → Camera**.

The widget sends the code to your computer once and gets a key of its own. It keeps only that key, encrypted with the phone's Android Keystore, and forgets the code. Your computer lists it in **Settings → Phone → Paired phones** as "VibeForge widget (your phone's model)".

Once any phone has paired with a key, the pairing code alone no longer opens the phone page; it only pairs. A phone browser that was using the code from before will ask to pair again, once.

If the widget says your computer no longer takes its key, it was removed in Settings → Phone, or **New code** signed every phone out. Open the widget's setup (⚙), tap **Scan the QR code** and scan it again: the widget pairs that computer again in its place.

To add another computer, open the setup (⚙) and scan the QR code in that computer's Settings → Phone. A computer the widget doesn't have yet is added beside the others; switch between them in the tray.

## Updates

Install a newer `vibeforge-widget.apk` over the old one. Android only allows that because both are signed with the same key; your computers and the widget's keys stay. If Android refuses the update, the file wasn't signed with that key: don't install it.

## Remove it

- On the phone: long-press the widget and remove it, then uninstall the **VibeForge Widget** app (long-press its icon → App info → Uninstall). This deletes its keys.
- On the computer: **Settings → Phone → Paired phones**, **Remove** beside "VibeForge widget". Do this too, so the key it had stops working even if the phone keeps a copy.

## Building it yourself

`scripts/build-android-widget.sh` builds it with the Android SDK, Java 21 and gradle. Without the release key your build is signed with your own debug key, so it can't update a widget installed from a release (uninstall that one first). `scripts/publish-android-widget.sh <tag>` is how a release gets its APK: it refuses anything not signed with the release key.
