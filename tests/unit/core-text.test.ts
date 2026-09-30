import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { matchCoreText } from "../../src/ui/core-text.js";
import { loadLanguage, translate } from "../../src/ui/i18n/index.js";

/** Messages a person never sees (programming errors, the bridge, services' own words), left in English. */
const INTERNAL = [
  /^Not allowed\.$/,
  /^Unknown (call|event|op|X) /,
  /^Layout is not valid$/,
  /^Run is not valid$/,
  /^Agent is missing$/,
  /^Nothing is being recorded\.$/,
  /^whisper-server/,
  /answered X/,
  /^GitHub sent no contribution calendar\.$/,
  /^Could not (make the copy|read the copy's changes)/,
  /^The changes don't apply to the workspace/,
  /^Unknown X X$/,
];

function sources(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sources(full);
    return /\.(ts|cjs)$/.test(entry.name) ? [full] : [];
  });
}

/** `throw new Error("…")` and `throw new Error(`…${x}…`)`, with each value replaced by "X". */
function thrownMessages(): Array<{ file: string; text: string }> {
  const found: Array<{ file: string; text: string }> = [];
  for (const file of [...sources("src/core"), ...sources("electron")]) {
    const code = fs.readFileSync(file, "utf8");
    for (const match of code.matchAll(/throw new Error\((?:"((?:[^"\\]|\\.)*)"|`((?:[^`\\]|\\.)*)`)\)/g)) {
      const text = (match[1] ?? match[2]).replace(/\$\{[^}]*\}/g, "X").replace(/\\"/g, '"');
      found.push({ file, text });
    }
  }
  return found;
}

describe("messages from the main process", () => {
  it("has a translation for every message a person can see", () => {
    const missing = thrownMessages().filter(({ text }) => !INTERNAL.some((pattern) => pattern.test(text)) && !matchCoreText(text));
    expect(missing).toEqual([]);
  });

  it("recognises a message with values in it and translates the values too", async () => {
    await loadLanguage("de");
    expect(matchCoreText("Claude Code (claude) is not on PATH.")).toEqual({ key: "core.engineMissing", vars: { label: "Claude Code", bin: "claude" } });
    const found = matchCoreText("Could not start Codex: That folder does not exist any more.");
    expect(found?.key).toBe("core.couldNotStart");
    expect(translate("de", "core.folderGone")).toBe("Dieser Ordner existiert nicht mehr.");
    expect(matchCoreText("Something nobody wrote down")).toBeNull();
  });
});
