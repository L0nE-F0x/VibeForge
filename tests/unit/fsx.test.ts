import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readJson, writeFileAtomic, writeJson } from "../../src/core/fsx.js";

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

  it("writes a file only its owner may read when asked, and tightens one that was open to all", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vibeforge-fsx-"));
    const file = path.join(dir, "settings.json");
    const mode = (name: string) => fs.statSync(name).mode & 0o777;
    writeJson(file, { token: "vf_a" }, { mode: 0o600 });
    expect(mode(file)).toBe(0o600);
    fs.chmodSync(file, 0o644);
    writeJson(file, { token: "vf_b" }, { mode: 0o600 });
    expect(mode(file)).toBe(0o600);
    expect(readJson(file, null)).toEqual({ token: "vf_b" });
    // A temp file a crash left behind doesn't decide either, nor does a broken file set aside keep its old mode.
    fs.writeFileSync(path.join(dir, `.settings.json.${process.pid}.tmp`), "", { mode: 0o666 });
    fs.chmodSync(path.join(dir, `.settings.json.${process.pid}.tmp`), 0o666);
    fs.writeFileSync(file, '{ "token": "vf_c", ', { mode: 0o644 });
    fs.chmodSync(file, 0o644);
    writeJson(file, { token: "vf_d" }, { mode: 0o600 });
    expect(mode(file)).toBe(0o600);
    expect(mode(`${file}.broken`)).toBe(0o600);
    // Without a mode, a file is written as before.
    const plain = path.join(dir, "layout.json");
    writeFileAtomic(plain, "{}\n");
    fs.writeFileSync(path.join(dir, "plain"), "");
    expect(mode(plain)).toBe(mode(path.join(dir, "plain")));
  });
});
