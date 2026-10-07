import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readJson, writeJson } from "../../src/core/fsx.js";

describe("JSON files", () => {
  it("moves a file that doesn't parse aside before writing over it", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vibeforge-fsx-"));
    const file = path.join(dir, "settings.json");
    fs.writeFileSync(file, '{ "notify": false, ');
    expect(readJson(file, { fallback: true })).toEqual({ fallback: true });
    writeJson(file, { notify: true });
    expect(readJson(file, null)).toEqual({ notify: true });
    expect(fs.readFileSync(`${file}.broken`, "utf8")).toBe('{ "notify": false, ');

    // A second broken edit doesn't replace the first one set aside.
    fs.writeFileSync(file, "{ oops");
    writeJson(file, { notify: false });
    expect(fs.readFileSync(`${file}.broken`, "utf8")).toBe('{ "notify": false, ');
    expect(fs.readdirSync(dir).filter((name) => name.startsWith("settings.json.broken-"))).toHaveLength(1);

    // A file that parses, or an empty one, is simply replaced.
    writeJson(file, { notify: true });
    fs.writeFileSync(file, "");
    writeJson(file, { notify: true });
    expect(fs.readdirSync(dir).filter((name) => name.includes(".broken"))).toHaveLength(2);
  });
});
