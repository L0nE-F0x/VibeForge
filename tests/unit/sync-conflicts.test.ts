import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ConflictStore, copiesIn, KEEP_ANSWERED_MS, walkCopies } from "../../src/core/sync/conflicts.js";

const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), "vibeforge-sync-conflicts-"));
const COPY = "notes.sync-conflict-20261117-204452-MTOM47S.txt";

function workspace(): string {
  const root = temp();
  fs.mkdirSync(path.join(root, "src", "deep"), { recursive: true });
  fs.mkdirSync(path.join(root, "node_modules", "pkg"), { recursive: true });
  fs.mkdirSync(path.join(root, ".git", "refs"), { recursive: true });
  fs.writeFileSync(path.join(root, "notes.txt"), "theirs\n");
  fs.writeFileSync(path.join(root, COPY), "mine\n");
  fs.writeFileSync(path.join(root, "src", "deep", "a.sync-conflict-20261117-204452-MTOM47S.ts"), "mine a\n");
  fs.writeFileSync(path.join(root, "node_modules", "pkg", "x.sync-conflict-20261117-204452-MTOM47S.js"), "ignored\n");
  fs.writeFileSync(path.join(root, ".git", "index.sync-conflict-20261117-204452-MTOM47S"), "git's own\n");
  return root;
}

describe("sync: files both machines changed", () => {
  it("finds Syncthing's copies in a folder, and in a whole workspace but for what never syncs", () => {
    const root = workspace();
    expect(copiesIn(root).map((copy) => [path.basename(copy.file), copy.name.original])).toEqual([[COPY, "notes.txt"]]);
    expect(copiesIn(path.join(root, "missing"))).toEqual([]);
    expect(walkCopies(root).map((copy) => path.relative(root, copy.file)).sort()).toEqual([COPY, path.join("src", "deep", "a.sync-conflict-20261117-204452-MTOM47S.ts")].sort());
    // A huge tree is cut short rather than walked for ever.
    expect(walkCopies(root, 1).length).toBe(1);
  });

  it("takes a copy out of the workspace and keeps it until it is answered", async () => {
    const root = workspace();
    let now = new Date("2026-11-17T12:00:00Z");
    const storeDir = path.join(temp(), "conflicts");
    const store = new ConflictStore(storeDir, () => now);
    expect(store.list()).toEqual([]);
    const [copy] = copiesIn(root);
    const record = store.keepFile("vf-ws-000000000000", root, copy);
    expect(record).toMatchObject({ folderId: "vf-ws-000000000000", root, kind: "file", path: "notes.txt", winner: "MTOM47S", savedBranch: null });
    expect(fs.existsSync(copy.file)).toBe(false);
    expect(fs.readFileSync(store.savedFile(record!.id), "utf8")).toBe("mine\n");
    expect(store.list()).toHaveLength(1);

    const diff = await store.diff(record!.id);
    expect(diff).toContain("--- a/notes.txt");
    expect(diff).toContain("+++ b/notes.txt");
    expect(diff).toContain("-theirs");
    expect(diff).toContain("+mine");
    expect(await store.diff("nope")).toBe("");

    // The same file loses again: the earlier unanswered copy moves to .answered/ so it isn't lost, and a fresh record takes the new one.
    fs.writeFileSync(path.join(root, COPY), "mine, newer\n");
    now = new Date("2026-11-17T13:00:00Z");
    const again = store.keepFile("vf-ws-000000000000", root, copiesIn(root)[0]);
    expect(again?.id).not.toBe(record!.id);
    expect(store.list()).toHaveLength(1);
    expect(fs.readFileSync(store.savedFile(again!.id), "utf8")).toBe("mine, newer\n");
    expect(fs.existsSync(path.join(storeDir, ".answered", record!.id, "mine"))).toBe(true);

    // "Put mine back": the file gets this machine's version, and the record is answered.
    expect(store.resolve(again!.id, "mine")?.path).toBe("notes.txt");
    expect(fs.readFileSync(path.join(root, "notes.txt"), "utf8")).toBe("mine, newer\n");
    expect(store.list()).toEqual([]);
    expect(store.resolve(again!.id, "mine")).toBeNull();
  });

  it("drops a copy that says nothing new, and restores a file the other machine deleted", () => {
    const root = workspace();
    const store = new ConflictStore(path.join(temp(), "conflicts"));
    fs.writeFileSync(path.join(root, COPY), "theirs\n");
    expect(store.keepFile("vf-ws-000000000000", root, copiesIn(root)[0])).toBeNull();
    expect(fs.existsSync(path.join(root, COPY))).toBe(false);
    expect(store.list()).toEqual([]);

    // The other machine deleted src/gone.ts after this one changed it: only the copy is left.
    const lost = path.join(root, "src", "gone.sync-conflict-20261117-204452-MTOM47S.ts");
    fs.writeFileSync(lost, "still wanted\n");
    const record = store.keepFile("vf-ws-000000000000", root, copiesIn(path.join(root, "src"))[0]);
    expect(record?.path).toBe("src/gone.ts");
    store.resolve(record!.id, "mine");
    expect(fs.readFileSync(path.join(root, "src", "gone.ts"), "utf8")).toBe("still wanted\n");
  });

  it("keeps the other machine's version when asked, notes kept commits, and tidies up after a month", () => {
    const root = workspace();
    let now = new Date("2026-11-17T12:00:00Z");
    const storeDir = path.join(temp(), "conflicts");
    const store = new ConflictStore(storeDir, () => now);
    const file = store.keepFile("vf-ws-000000000000", root, copiesIn(root)[0]);
    const commits = store.noteCommits("vf-ws-000000000000", root, "main", "main-from-desk", "MTOM47S");
    expect(store.noteCommits("vf-ws-000000000000", root, "main", "main-from-desk", "MTOM47S").id).toBe(commits.id);
    expect(store.list().map((record) => record.kind).sort()).toEqual(["commits", "file"]);
    expect(store.get(commits.id)).toMatchObject({ kind: "commits", path: "main", savedBranch: "main-from-desk" });

    store.resolve(file!.id, "theirs");
    expect(fs.readFileSync(path.join(root, "notes.txt"), "utf8")).toBe("theirs\n");
    store.forgetFolder("vf-ws-000000000000");
    expect(store.list()).toEqual([]);

    // Answered ones stay a month, then go.
    expect(store.tidy()).toBe(0);
    now = new Date(now.getTime() + KEEP_ANSWERED_MS + 60_000);
    expect(store.tidy()).toBe(2);
    expect(store.tidy()).toBe(0);
    expect(new ConflictStore(path.join(temp(), "none")).tidy()).toBe(0);
  });

  it("never writes outside the workspace", () => {
    const root = workspace();
    const dir = path.join(temp(), "conflicts");
    const store = new ConflictStore(dir);
    const record = store.keepFile("vf-ws-000000000000", root, copiesIn(root)[0]);
    const meta = path.join(dir, record!.id, "meta.json");
    fs.writeFileSync(meta, JSON.stringify({ ...record, path: "../../escaped.txt" }));
    expect(() => store.resolve(record!.id, "mine")).toThrow(/not inside the workspace/);
    expect(fs.existsSync(path.join(path.dirname(root), "escaped.txt"))).toBe(false);
  });

  it("refuses to overwrite a symlink target or walk through a symlinked directory when restoring mine", () => {
    const outside = temp();
    const secretFile = path.join(outside, "secret.txt");
    fs.writeFileSync(secretFile, "untouched\n");
    const outsideDir = path.join(outside, "dir");
    fs.mkdirSync(outsideDir, { recursive: true });
    fs.writeFileSync(path.join(outsideDir, "nested.txt"), "untouched-dir\n");

    const root = workspace();
    const store = new ConflictStore(path.join(temp(), "conflicts"));
    fs.rmSync(path.join(root, "notes.txt"));
    fs.symlinkSync(secretFile, path.join(root, "notes.txt"));
    const direct = store.keepFile("vf-ws-000000000000", root, copiesIn(root)[0]);
    expect(() => store.resolve(direct!.id, "mine")).toThrow(/symbolic link/i);
    expect(fs.readFileSync(secretFile, "utf8")).toBe("untouched\n");

    fs.symlinkSync(outsideDir, path.join(root, "linked"));
    const nestedCopy = path.join(root, "linked", "nested.sync-conflict-20261117-204452-MTOM47S.txt");
    fs.writeFileSync(nestedCopy, "evil\n");
    const nested = store.keepFile("vf-ws-000000000000", root, copiesIn(path.join(root, "linked"))[0]);
    expect(() => store.resolve(nested!.id, "mine")).toThrow(/symbolic link/i);
    expect(fs.readFileSync(path.join(outsideDir, "nested.txt"), "utf8")).toBe("untouched-dir\n");
  });

  it("refuses diff and does not short-circuit keepFile across symbolic links", async () => {
    const outside = temp();
    const secretFile = path.join(outside, "secret.txt");
    fs.writeFileSync(secretFile, "top-secret-token\n");
    const outsideDir = path.join(outside, "dir");
    fs.mkdirSync(outsideDir, { recursive: true });
    fs.writeFileSync(path.join(outsideDir, "nested.txt"), "same-content\n");

    const root = workspace();
    const store = new ConflictStore(path.join(temp(), "conflicts"));
    fs.rmSync(path.join(root, "notes.txt"));
    fs.symlinkSync(secretFile, path.join(root, "notes.txt"));
    const direct = store.keepFile("vf-ws-000000000000", root, copiesIn(root)[0]);
    expect(direct).not.toBeNull();
    await expect(store.diff(direct!.id)).rejects.toThrow(/symbolic link/i);

    fs.symlinkSync(outsideDir, path.join(root, "linked"));
    const nestedCopy = path.join(root, "linked", "nested.sync-conflict-20261117-204452-MTOM47S.txt");
    fs.writeFileSync(nestedCopy, "same-content\n");
    const nested = store.keepFile("vf-ws-000000000000", root, copiesIn(path.join(root, "linked"))[0]);
    expect(nested).not.toBeNull();
    await expect(store.diff(nested!.id)).rejects.toThrow(/symbolic link/i);
  });
});
