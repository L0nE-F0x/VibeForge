# R8 for the release APK: it drops the parts of the Kotlin library and ZXing the widget never calls.
#
# Nothing is renamed. Every class keeps its name, so a crash report from a phone reads as the code
# does, and nothing found by name can go missing. What the manifest and the layouts name (the
# activities, the widget's receiver, ZXing's camera views in activity_scan.xml) is kept by the rules
# the Android build writes from them. Neither the widget nor ZXing looks anything up by reflection:
# ZXing's only lookup by name is Charset.forName.
-dontobfuscate

# ZXing's own scan screen and its AndroidX helpers (CaptureActivity, CaptureManager, ScanContract,
# IntentIntegrator) go unused, and AndroidX isn't in the widget: their references to it are left dangling.
-dontwarn androidx.**
