import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { defaultRoots, ensureLayout } from "../../src/core/layout.js";
import { isSafeId, slugify } from "../../src/core/slug.js";
import { Trash } from "../../src/core/trash.js";

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "vibeforge-basics-"));

describe("ids", () => {
  it("makes a file-safe id from a name", () => {
    expect(slugify("  Release Notes: v2.1!  ")).toBe("release-notes-v2-1");
    expect(slugify("日本語")).toBe("item");
    expect(slugify("a".repeat(40) + " bbbbbbbbbbbb", 41)).toBe("a".repeat(40));
  });

  it("refuses an id that could leave its folder", () => {
    for (const id of ["notes", "notes-2", "a.b_c"]) expect(isSafeId(id)).toBe(true);
    for (const id of ["", "../x", "a/b", ".hidden", "-flag", "a..b", "a b"]) expect(isSafeId(id), id).toBe(false);
  });
});

describe("folders", () => {
  it("follows VIBEFORGE_* first, then XDG, then the home defaults", () => {
    const home = os.homedir();
    expect(defaultRoots({})).toEqual({ configRoot: path.join(home, ".config", "vibeforge"), dataRoot: path.join(home, ".local", "share", "vibeforge") });
    expect(defaultRoots({ XDG_CONFIG_HOME: "/x/config", XDG_DATA_HOME: "/x/data" })).toEqual({ configRoot: "/x/config/vibeforge", dataRoot: "/x/data/vibeforge" });
    expect(defaultRoots({ XDG_CONFIG_HOME: "/x/config", VIBEFORGE_CONFIG: "/v/c", VIBEFORGE_DATA: "/v/d" })).toEqual({ configRoot: "/v/c", dataRoot: "/v/d" });
  });

  it("creates every folder the app owns", () => {
    const config = path.join(tempDir(), "config");
    const data = path.join(tempDir(), "data");
    ensureLayout(config, data);
    expect(fs.readdirSync(config).sort()).toEqual(["agents", "layouts", "routines", "skills", "tasks"]);
    expect(fs.readdirSync(data).sort()).toEqual(["runs", "scratch"]);
  });
});

describe("trash", () => {
  it("moves files aside and puts them back, skipping ones that were never there", () => {
    const dir = tempDir();
    const trash = new Trash(path.join(dir, "trash"));
    const file = path.join(dir, "task.yaml");
    const folder = path.join(dir, "copy");
    fs.writeFileSync(file, "title: x\n");
    fs.mkdirSync(folder);
    fs.writeFileSync(path.join(folder, "a.txt"), "a\n");
    const bin = trash.stash([file, path.join(dir, "missing"), folder]);
    expect(bin.moved.map((item) => item.from)).toEqual([file, folder]);
    expect(fs.existsSync(file) || fs.existsSync(folder)).toBe(false);
    trash.restore(bin);
    expect(fs.readFileSync(file, "utf8")).toBe("title: x\n");
    expect(fs.readFileSync(path.join(folder, "a.txt"), "utf8")).toBe("a\n");
    expect(fs.existsSync(path.join(dir, "trash", bin.token))).toBe(false);
  });

  it("leaves a path taken again in the meantime alone, and empties for good", () => {
    const dir = tempDir();
    const trash = new Trash(path.join(dir, "trash"));
    const file = path.join(dir, "skill.md");
    fs.writeFileSync(file, "old\n");
    const bin = trash.stash([file]);
    fs.writeFileSync(file, "new\n");
    trash.restore(bin);
    expect(fs.readFileSync(file, "utf8")).toBe("new\n");

    const gone = trash.stash([file]);
    trash.drop(gone);
    trash.restore(gone);
    expect(fs.existsSync(file)).toBe(false);
    trash.stash([path.join(dir, "missing")]);
    trash.empty();
    expect(fs.existsSync(path.join(dir, "trash"))).toBe(false);
  });
});
