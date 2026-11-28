import { spawnSync } from "node:child_process";
import os from "node:os";

// What a test needs to start Electron where it will actually start. Only for the smoke test, the
// end-to-end driver and the unit tests: the app people run keeps Chromium's sandbox.

let sandboxless;

/**
 * Whether Chromium's sandbox can't start here, so Electron needs `--no-sandbox`: in CI, or
 * inside another sandbox that blocks user namespaces (a coding CLI's own, as Antigravity runs
 * its commands in). There Chromium stops at start with "credentials.cc … Function not implemented"
 * and dumps core.
 * @returns {boolean}
 */
export function needsNoSandbox() {
  if (process.env.CI) return true;
  sandboxless ??= spawnSync("unshare", ["-Ur", "true"], { stdio: "ignore", timeout: 5000 }).status !== 0;
  return sandboxless;
}

/** The longest temp folder a test starts Electron from: its lock socket's path has to fit in about 100 characters. */
export const TMP_MAX = 60;

/**
 * A temp folder short enough for Chromium: `dir` (the system's, by default) unless it is longer
 * than TMP_MAX, as a coding CLI's own scratch folder often is, then /tmp. A longer one crashes
 * Electron at start.
 * @param {string} [dir]
 * @returns {string}
 */
export function shortTmp(dir = os.tmpdir()) {
  return dir.length <= TMP_MAX ? dir : "/tmp";
}
