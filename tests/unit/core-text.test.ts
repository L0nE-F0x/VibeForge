import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { matchCoreText } from "../../src/ui/core-text.js";
import { loadLanguage, translate } from "../../src/ui/i18n/index.js";
import { BLOCKER_TEXT } from "../../src/core/service/types.js";

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
  // A step's name and git's answer, joined by `failure` in worktrees.ts; the step names are above.
  /^X: X$/,
  /^whisper-cli /,
];

function sources(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sources(full);
    return /\.(ts|cjs)$/.test(entry.name) ? [full] : [];
  });
}

/**
 * Every string a `new Error(…)` is made from, thrown or rejected, with each value replaced by "X":
 * a plain literal, both sides of a ternary, a fallback after `||`. Only sentences count (they have
 * a space), so a `"cron"` compared inside the call isn't taken for a message.
 */
function thrownMessages(): Array<{ file: string; text: string }> {
  const found: Array<{ file: string; text: string }> = [];
  for (const file of [...sources("src/core"), ...sources("electron")]) {
    const code = fs.readFileSync(file, "utf8");
    for (const match of code.matchAll(/new Error\(/g)) {
      for (const text of literalsIn(code, match.index + match[0].length)) {
        if (text.includes(" ")) found.push({ file, text });
      }
    }
  }
  return found;
}

/** The string literals inside the call whose argument list starts at `start`, up to its closing paren. */
function literalsIn(code: string, start: number): string[] {
  const literals: string[] = [];
  let depth = 1;
  let at = start;
  while (at < code.length && depth > 0) {
    const char = code[at];
    if (char === '"' || char === "'" || char === "`") {
      const [text, end] = readString(code, at);
      literals.push(text);
      at = end;
      continue;
    }
    if (char === "(") depth += 1;
    if (char === ")") depth -= 1;
    at += 1;
  }
  return literals;
}

/** A string literal at `at`, its `${…}` parts as "X" (nested literals and all), and where it ends. */
function readString(code: string, at: number): [string, number] {
  const quote = code[at];
  let text = "";
  let index = at + 1;
  while (index < code.length && code[index] !== quote) {
    if (code[index] === "\\") {
      text += code[index + 1] === quote ? quote : code.slice(index, index + 2);
      index += 2;
    } else if (quote === "`" && code.startsWith("${", index)) {
      let depth = 1;
      index += 2;
      while (index < code.length && depth > 0) {
        if (code[index] === '"' || code[index] === "'" || code[index] === "`") index = readString(code, index)[1];
        else {
          if (code[index] === "{") depth += 1;
          if (code[index] === "}") depth -= 1;
          index += 1;
        }
      }
      text += "X";
    } else {
      text += code[index];
      index += 1;
    }
  }
  return [text, index + 1];
}

describe("messages from the main process", () => {
  it("has a translation for every message a person can see", () => {
    const missing = thrownMessages().filter(({ text }) => !INTERNAL.some((pattern) => pattern.test(text)) && !matchCoreText(text));
    expect(missing).toEqual([]);
  });

  it("finds messages that aren't a single literal, and checks the blocker sentences", () => {
    const texts = thrownMessages().map(({ text }) => text);
    expect(texts).toContain("That cron expression is not valid (five fields, local time).");
    expect(texts).toContain("Intervals must be at least 5 minutes.");
    expect(texts).toContain("X does not allow routines. Turn it on in the agent's settings.");
    expect(texts).toContain("The terminal host did not start within 10 seconds.");
    expect(texts).not.toContain("cron");
    expect(matchCoreText("The terminal host stopped. It stopped 4 times in five minutes, so it stays off: restart VibeForge.")?.key).toBe("core.hostCrashLoop");
    for (const text of Object.values(BLOCKER_TEXT)) expect(matchCoreText(text), text).not.toBeNull();
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
