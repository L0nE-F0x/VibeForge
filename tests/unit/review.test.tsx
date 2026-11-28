import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MESSAGE_INLINE_MAX } from "../../src/core/agent-talk.js";
import type { ReviewFile } from "../../src/shared/api.js";
import { formatReviewNotes, isLockFile, notesThatFit, parseDiffGitHeader, parseFileDiff, splitPatch, syntaxLang, tokenizeLine, unquoteGitPath } from "../../src/shared/review.js";
import { useCopyPick, type CopyPick } from "../../src/ui/copy-pick.js";
import { DiffReview } from "../../src/ui/components/DiffReview.js";
import { remember, resetPlaces } from "../../src/ui/remember.js";
import { NavProvider, ToastProvider } from "../../src/ui/state.js";
import { setup, started, tempDir } from "./fixtures/service-harness.js";

// Rendered on the server, with no main process: Send to… lists no CLIs.
vi.mock("../../src/ui/api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/ui/api.js")>()),
  useLive: () => ({ data: [] }),
  useAgents: () => ({ data: [] }),
  useWorkspaces: () => ({ data: undefined }),
}));

/** Renders useCopyPick on the server, unticking `untick` once, and hands back what it gave. */
function PickProbe({ files, untick, onPick }: { files: ReviewFile[] | null; untick?: string; onPick: (pick: CopyPick) => void }) {
  const pick = useCopyPick(files);
  if (untick && pick.selection?.picked.has(untick)) pick.selection.onToggle(untick);
  onPick(pick);
  return null;
}

function initGitRepo(files: Record<string, string>): string {
  const repo = tempDir();
  const git = (...args: string[]) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args], { cwd: repo, stdio: "pipe" });
  git("init", "-q");
  for (const [name, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(repo, name)), { recursive: true });
    fs.writeFileSync(path.join(repo, name), body);
  }
  git("add", "-A");
  git("commit", "-qm", "init");
  return repo;
}

describe("patch splitting, folding, syntax tokens and review notes", () => {
  afterEach(() => {
    resetPlaces();
    try {
      if (typeof localStorage !== "undefined") localStorage.clear();
    } catch {
      /* localStorage unavailable in bare node */
    }
  });

  it("splits patches per file across modified, added, deleted, renamed, C-quoted and binary entries", () => {
    const patch = [
      "diff --git a/src/app.ts b/src/app.ts",
      "index 1111111..2222222 100644",
      "--- a/src/app.ts",
      "+++ b/src/app.ts",
      "@@ -1,3 +1,4 @@",
      " const a = 1;",
      "-const b = 2;",
      "+const b = 3;",
      "+++count;",
      "diff --git a/new.py b/new.py",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/new.py",
      "@@ -0,0 +1,2 @@",
      "+def hi():",
      "+    return 1",
      "diff --git a/old.txt b/old.txt",
      "deleted file mode 100644",
      "--- a/old.txt",
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      "-gone",
      "diff --git \"a/dir b/caf\\303\\251.txt\" \"b/dir b/latte.txt\"",
      "similarity index 90%",
      "rename from \"dir b/caf\\303\\251.txt\"",
      "rename to \"dir b/latte.txt\"",
      "@@ -1 +1 @@",
      "-old",
      "+new",
      "diff --git a/logo.png b/logo.png",
      "GIT binary patch",
      "literal 4",
      "LcmZQzU|<0R002M$",
      "",
      "# New files left in the working tree",
      "# big.bin: 500000 bytes, left in the working tree",
    ].join("\n");

    const parsed = splitPatch(patch);
    expect(parsed.notes).toEqual(["New files left in the working tree", "big.bin: 500000 bytes, left in the working tree"]);
    expect(parsed.files.map((f) => ({ path: f.path, oldPath: f.oldPath, status: f.status, binary: f.binary, added: f.added, removed: f.removed, fold: f.foldReason }))).toEqual([
      { path: "src/app.ts", oldPath: null, status: "modified", binary: false, added: 2, removed: 1, fold: null },
      { path: "new.py", oldPath: null, status: "added", binary: false, added: 2, removed: 0, fold: null },
      { path: "old.txt", oldPath: null, status: "deleted", binary: false, added: 0, removed: 1, fold: null },
      { path: "dir b/latte.txt", oldPath: "dir b/café.txt", status: "renamed", binary: false, added: 1, removed: 1, fold: null },
      { path: "logo.png", oldPath: null, status: "modified", binary: true, added: 0, removed: 0, fold: "binary" },
    ]);
    // Trailing # notes were stripped cleanly from the last file's raw slice.
    expect(parsed.files[4].raw).not.toContain("# New files left");
    expect(splitPatch("")).toEqual({ files: [], notes: [] });
  });

  it("handles spaces, ' b/' substrings, and C-quoted escapes in diff headers", () => {
    expect(unquoteGitPath('"caf\\303\\251\\t\\"x\\"\\\\.txt"')).toBe('café\t"x"\\.txt');
    expect(parseDiffGitHeader("diff --git a/a b/c.txt b/a b/c.txt")).toEqual({ oldPath: "a b/c.txt", path: "a b/c.txt" });
    expect(parseDiffGitHeader('diff --git "a/a\\n1.txt" "b/a\\n1.txt"')).toEqual({ oldPath: "a\n1.txt", path: "a\n1.txt" });
    expect(parseDiffGitHeader("not a header")).toBeNull();
  });

  it("folds lock files, large files, and long 70+ file diffs past the initial budget", () => {
    expect(isLockFile("package-lock.json")).toBe(true);
    expect(isLockFile("web/pnpm-lock.yaml")).toBe(true);
    expect(isLockFile("rust/Cargo.lock")).toBe(true);
    expect(isLockFile("dist/app.min.js")).toBe(true);
    expect(isLockFile("src/index.ts")).toBe(false);

    const lockBlock = ["diff --git a/package-lock.json b/package-lock.json", "--- a/package-lock.json", "+++ b/package-lock.json", "@@ -1 +1 @@", "-{}", '+{"lock":true}'].join("\n");
    const bigBody = Array.from({ length: 310 }, (_, idx) => `+const x${idx} = ${idx};`).join("\n");
    const bigBlock = ["diff --git a/src/big.ts b/src/big.ts", "new file mode 100644", "--- /dev/null", "+++ b/src/big.ts", "@@ -0,0 +1,310 @@", bigBody].join("\n");

    const manyFiles = Array.from({ length: 75 }, (_, i) => {
      const body = Array.from({ length: 50 }, (__, line) => `+export const v_${i}_${line} = ${line};`).join("\n");
      return [`diff --git a/src/f${i}.ts b/src/f${i}.ts`, "new file mode 100644", "--- /dev/null", `+++ b/src/f${i}.ts`, "@@ -0,0 +1,50 @@", body].join("\n");
    }).join("\n");

    const combined = `${lockBlock}\n${bigBlock}\n${manyFiles}`;
    const parsed = splitPatch(combined);
    expect(parsed.files).toHaveLength(77);
    expect(parsed.files[0].startFolded).toBe(true);
    expect(parsed.files[0].foldReason).toBe("lock");
    expect(parsed.files[1].startFolded).toBe(true);
    expect(parsed.files[1].foldReason).toBe("large");
    // Early small files stay unfolded; later ones fold under the cumulative line budget.
    expect(parsed.files[2].startFolded).toBe(false);
    expect(parsed.files.at(-1)?.startFolded).toBe(true);
    expect(parsed.files.at(-1)?.foldReason).toBe("many");
  });

  it("parses file hunks lazily with old/new line numbers and stops cleanly on binary payloads", () => {
    const raw = [
      "diff --git a/src/demo.ts b/src/demo.ts",
      "index 1234567..89abcde 100644",
      "--- a/src/demo.ts",
      "+++ b/src/demo.ts",
      "@@ -10,3 +10,3 @@ export function demo() {",
      " const a = 1;",
      "-const b = 2;",
      "+const b = 3;",
      " return a + b;",
      "\\ No newline at end of file",
    ].join("\n");
    expect(parseFileDiff(raw)).toEqual([
      { kind: "hunk", text: "@@ -10,3 +10,3 @@ export function demo() {", oldNo: null, newNo: null },
      { kind: "ctx", code: "const a = 1;", oldNo: 10, newNo: 10 },
      { kind: "del", code: "const b = 2;", oldNo: 11, newNo: null },
      { kind: "add", code: "const b = 3;", oldNo: null, newNo: 11 },
      { kind: "ctx", code: "return a + b;", oldNo: 12, newNo: 12 },
      { kind: "meta", text: "\\ No newline at end of file", oldNo: null, newNo: null },
    ]);

    const bin = ["diff --git a/img.png b/img.png", "GIT binary patch", "literal 4", "abcd"].join("\n");
    expect(parseFileDiff(bin)).toEqual([{ kind: "meta", text: "GIT binary patch", oldNo: null, newNo: null }]);
    expect(parseFileDiff("")).toEqual([]);
  });

  it("tokenizes common languages into theme token kinds and skips huge lines", () => {
    expect(syntaxLang("app.tsx")).toBe("js");
    expect(syntaxLang("script.py")).toBe("py");
    expect(syntaxLang("lib.rs")).toBe("rs");
    expect(syntaxLang("config.yaml")).toBe("sh");
    expect(syntaxLang("data.json")).toBe("json");
    expect(syntaxLang("styles.css")).toBe("css");
    expect(syntaxLang("page.html")).toBe("html");
    expect(syntaxLang("query.sql")).toBe("sql");
    expect(syntaxLang("README.md")).toBe("md");
    expect(syntaxLang("notes.txt")).toBe("plain");

    expect(tokenizeLine('const count: UserRecord = 42; // keep "ok"', "js")).toEqual(
      expect.arrayContaining([
        { kind: "kw", text: "const" },
        { kind: "ty", text: "UserRecord" },
        { kind: "num", text: "42" },
        { kind: "com", text: '// keep "ok"' },
      ]),
    );
    expect(tokenizeLine('{"name": true, "n": 10}', "json")).toEqual(
      expect.arrayContaining([
        { kind: "ty", text: '"name"' },
        { kind: "kw", text: "true" },
        { kind: "num", text: "10" },
      ]),
    );
    expect(tokenizeLine("@media (min-width: 12px) { color: #ff6b35; }", "css")).toEqual(
      expect.arrayContaining([
        { kind: "kw", text: "@media" },
        { kind: "num", text: "12px" },
        { kind: "num", text: "#ff6b35" },
      ]),
    );
    expect(tokenizeLine("<!-- hi --><div class='a'>", "html")).toEqual(
      expect.arrayContaining([
        { kind: "com", text: "<!-- hi -->" },
        { kind: "kw", text: "<div" },
        { kind: "str", text: "'a'" },
      ]),
    );
    expect(tokenizeLine("# Heading", "md")).toEqual([{ kind: "kw", text: "# Heading" }]);
    expect(tokenizeLine("Use `foo` here", "md")).toEqual(expect.arrayContaining([{ kind: "str", text: "`foo`" }]));
    expect(tokenizeLine("SELECT id FROM users -- all", "sql")).toEqual(
      expect.arrayContaining([{ kind: "kw", text: "SELECT" }, { kind: "com", text: "-- all" }]),
    );
    const long = "x".repeat(501);
    expect(tokenizeLine(long, "js")).toEqual([{ text: long }]);
  });

  it("formats line notes ordered by file and line number and skips blank ones", () => {
    const out = formatReviewNotes(
      [
        { id: "1", path: "src/b.ts", line: 20, side: "new", code: "return x;", body: "Check null case." },
        { id: "2", path: "src/a.ts", line: 5, side: "old", code: "const legacy = 1;", body: "Line 1\nLine 2" },
        { id: "3", path: "src/a.ts", line: 3, side: "new", body: "Needs rename." },
        { id: "4", path: "src/a.ts", line: 9, side: "new", body: "   " },
      ],
      ["src/a.ts", "src/b.ts"],
    );
    expect(out).toBe(
      [
        "Review notes:",
        "",
        "- src/a.ts:3",
        "  Needs rename.",
        "- src/a.ts:5 (removed, `const legacy = 1;`)",
        "  Line 1",
        "  Line 2",
        "- src/b.ts:20 (`return x;`)",
        "  Check null case.",
      ].join("\n"),
    );
    expect(formatReviewNotes([{ id: "1", path: "a.ts", line: 1, side: "new", body: "  " }])).toBe("");
  });

  it("sends review notes as a draft into a live CLI prompt and supports partial task copy Apply", async () => {
    const repo = initGitRepo({ "a.txt": "a1\n", "b.txt": "b1\n" });
    const ctx = setup();
    const workspace = ctx.svc.addWorkspace(repo).workspaces[0];
    const cli = await ctx.svc.startEngine({ workspaceId: workspace.id, engineId: "argy" });

    // 1. Short notes go directly as a draft (enter: false).
    expect(await ctx.svc.sendDraft({ fromPty: null, toPty: cli.ptyId, what: "notes", selection: "Review notes:\n\n- a.txt:1\n  Fix typo." })).toEqual({ sent: true });
    expect(ctx.sent.at(-1)).toEqual({ ptyId: cli.ptyId, text: "Review notes:\n\n- a.txt:1\n  Fix typo.", enter: false });

    // 2. Long notes are written to a file and named in the draft.
    const huge = `Review notes:\n\n- a.txt:1\n  ${"x".repeat(MESSAGE_INLINE_MAX + 100)}`;
    expect(await ctx.svc.sendDraft({ fromPty: null, toPty: cli.ptyId, what: "notes", selection: huge })).toEqual({ sent: true });
    const draft = ctx.sent.at(-1)?.text ?? "";
    const savedPath = /^Review notes saved at (\S+)\. Read them first\.$/.exec(draft)?.[1] ?? "";
    expect(fs.readFileSync(savedPath, "utf8")).toContain("Review notes:");

    // 3. Blank notes or missing target CLI.
    expect(await ctx.svc.sendDraft({ fromPty: null, toPty: cli.ptyId, what: "notes", selection: "  " })).toEqual({ sent: false });
    await expect(ctx.svc.sendDraft({ fromPty: null, toPty: "pty-missing", what: "notes", selection: "hi" })).rejects.toThrow("That CLI isn't running any more.");

    // 4. TaskDesk.copyDiff & partial TaskDesk.applyCopy keep the copy until every file is applied.
    const agent = await ctx.svc.saveAgent({ name: "Reviewer", brief: "Work.", engine: "argy", places: [repo] });
    const task = ctx.svc.saveTask({ title: "Two files", body: "Edit both.", agentId: agent.id, workspaceId: workspace.id, isolated: true });
    const launched = started(await ctx.svc.executeTask(task.id));
    const copyPath = ctx.svc.listTasks().find((item) => item.id === task.id)!.copy!.path;
    fs.writeFileSync(path.join(copyPath, "a.txt"), "a2\n");
    fs.writeFileSync(path.join(copyPath, "b.txt"), "b2\n");
    await ctx.exit(launched.ptyId);

    const review = await ctx.svc.taskCopyDiff(task.id);
    expect(review.patch).toContain("a.txt");
    expect(review.patch).toContain("b.txt");
    expect(review.files).toEqual([
      { path: "a.txt", oldPath: null, applied: false },
      { path: "b.txt", oldPath: null, applied: false },
    ]);
    await expect(ctx.svc.taskCopyDiff("missing-task")).rejects.toThrow("That task no longer exists.");
    const plainTask = ctx.svc.saveTask({ title: "No copy", body: "Direct.", agentId: agent.id, workspaceId: workspace.id, isolated: false });
    await expect(ctx.svc.taskCopyDiff(plainTask.id)).rejects.toThrow("This task has no separate copy.");

    const partial = await ctx.svc.applyTaskCopy(task.id, ["b.txt"]);
    expect(partial).toEqual({ files: ["a.txt"], conflicts: [], kept: [], stayed: 1 });
    expect(fs.readFileSync(path.join(repo, "a.txt"), "utf8")).toBe("a2\n");
    expect(fs.readFileSync(path.join(repo, "b.txt"), "utf8")).toBe("b1\n");
    const stillOpen = ctx.svc.listTasks().find((item) => item.id === task.id)!;
    expect(stillOpen.copy).not.toBeNull();
    expect(stillOpen.status).toBe("review");
    // The task's copy remembers what went in: the next review starts a.txt unticked, marked applied.
    expect(stillOpen.copy?.applied?.map((file) => file.path)).toEqual(["a.txt"]);
    expect((await ctx.svc.taskCopyDiff(task.id)).files.map((file) => [file.path, file.applied])).toEqual([
      ["a.txt", true],
      ["b.txt", false],
    ]);
    // Reverted in the workspace since: the rest of the copy goes in without bringing it back.
    fs.writeFileSync(path.join(repo, "a.txt"), "a1\n");

    // Applying the remaining file clears the copy and finishes the task.
    const rest = await ctx.svc.applyTaskCopy(task.id, ["a.txt"]);
    expect(rest).toEqual({ files: ["b.txt"], conflicts: [], kept: [], already: 1 });
    expect(fs.readFileSync(path.join(repo, "a.txt"), "utf8")).toBe("a1\n");
    expect(fs.readFileSync(path.join(repo, "b.txt"), "utf8")).toBe("b2\n");
    const finished = ctx.svc.listTasks().find((item) => item.id === task.id)!;
    expect(finished.copy).toBeNull();
    expect(finished.status).toBe("done");
    ctx.svc.close();
  });

  it("renders file list, syntax colours, lazy folded files, applied files and notes in DiffReview SSR", () => {
    const patch = [
      "diff --git a/src/app.ts b/src/app.ts",
      "--- a/src/app.ts",
      "+++ b/src/app.ts",
      "@@ -1 +1 @@",
      "-const a = 1;",
      "+const a = 2;",
      "diff --git a/package-lock.json b/package-lock.json",
      "--- a/package-lock.json",
      "+++ b/package-lock.json",
      "@@ -1 +1 @@",
      '-{"old":1}',
      '+{"lockToken":"secret_never_rendered_while_folded"}',
    ].join("\n");

    remember("run.notes", "run-1", [{ id: "n1", path: "src/app.ts", line: 1, side: "new", code: "const a = 2;", body: "Check constant" }]);

    const html = renderToStaticMarkup(
      <NavProvider>
        <ToastProvider>
          <DiffReview
            text={patch}
            reviewKey="run-1"
            folder="/work/copy"
            selection={{
              picked: new Set(["src/app.ts"]),
              applied: new Set(["package-lock.json"]),
              onToggle: () => undefined,
              onPickAll: () => undefined,
              onPickNone: () => undefined,
            }}
          />
        </ToastProvider>
      </NavProvider>,
    );
    expect(html).toContain("src/app.ts");
    expect(html).toContain("package-lock.json");
    expect(html).toContain("Lock file folded");
    expect(html).toContain("tok-kw");
    expect(html).toContain("tok-num");
    expect(html).toContain("1/2 selected");
    expect(html).toContain("Check constant");
    expect(html).toContain("Send to…");
    expect(html).toContain(">applied<");
    // One note button per file, not one per line.
    expect(html.match(/diff-note-trigger/g)).toHaveLength(1);
    // Folded file's diff lines are rendered lazily: not present in HTML while folded.
    expect(html).not.toContain("secret_never_rendered_while_folded");
  });
  it("keeps viewed ticks for the version of a file that was viewed, and drops notes whose line changed", () => {
    const patch = (value: number) =>
      ["diff --git a/src/app.ts b/src/app.ts", "--- a/src/app.ts", "+++ b/src/app.ts", "@@ -1 +1 @@", "-const a = 1;", `+const a = ${value};`, "diff --git a/b.txt b/b.txt", "--- a/b.txt", "+++ b/b.txt", "@@ -1 +1 @@", "-x", "+y"].join("\n");
    const first = splitPatch(patch(2)).files[0];
    const render = (text: string) =>
      renderToStaticMarkup(
        <NavProvider>
          <ToastProvider>
            <DiffReview text={text} reviewKey="task:t1" />
          </ToastProvider>
        </NavProvider>,
      );
    remember("run.viewed", "task:t1", [`${first.key}:src/app.ts`]);
    remember("run.notes", "task:t1", [{ id: "n1", path: "src/app.ts", line: 1, side: "new", code: "const a = 2;", body: "Why two?" }]);

    // Viewed: counted, and folded.
    const viewed = render(patch(2));
    expect(viewed).toContain("1/2 viewed");
    expect(viewed).not.toContain("const a");
    expect(viewed).toContain("1 note");

    // The CLI changed the file again after Continue: it shows again, unviewed, and the note on
    // the line that changed is gone.
    const changed = render(patch(3));
    expect(splitPatch(patch(3)).files[0].key).not.toBe(first.key);
    expect(changed).toContain("0/2 viewed");
    expect(changed).toContain("tok-num");
    expect(changed).not.toContain("Why two?");
    expect(changed).not.toContain("1 note");
  });

  it("keeps notes on lines that still read the same, and names the folder at the top of the message", () => {
    const files = splitPatch(["diff --git a/a.ts b/a.ts", "--- a/a.ts", "+++ b/a.ts", "@@ -1,2 +1,2 @@", " keep();", "-old();", "+fresh();"].join("\n")).files;
    const notes = [
      { id: "1", path: "a.ts", line: 1, side: "new" as const, code: "keep();", body: "ok" },
      { id: "2", path: "a.ts", line: 2, side: "old" as const, code: "old();", body: "gone?" },
      { id: "3", path: "a.ts", line: 2, side: "new" as const, code: "stale();", body: "moved" },
      { id: "4", path: "elsewhere.ts", line: 1, side: "new" as const, code: "x", body: "not in this patch" },
    ];
    expect(notesThatFit(notes, files).map((note) => note.id)).toEqual(["1", "2"]);
    expect(formatReviewNotes([notes[0]], ["a.ts"], "/home/me/.local/share/vibeforge/worktrees/t1").split("\n")[0]).toBe(
      "Review notes on the changes in /home/me/.local/share/vibeforge/worktrees/t1 (paths are from the top of its git repository):",
    );
  });

  it("starts files applied before unticked, and sends both names of an unticked rename", () => {
    const files: ReviewFile[] = [
      { path: "a.txt", oldPath: null, applied: true },
      { path: "new.txt", oldPath: "old.txt", applied: false },
      { path: "c.txt", oldPath: null, applied: false },
    ];
    const pickOf = (list: ReviewFile[] | null, untick?: string) => {
      let seen: CopyPick | null = null;
      renderToStaticMarkup(<PickProbe files={list} untick={untick} onPick={(pick) => (seen = pick)} />);
      return seen as unknown as CopyPick;
    };
    const pick = pickOf(files);
    expect([...(pick.selection?.picked ?? [])]).toEqual(["new.txt", "c.txt"]);
    expect([...(pick.selection?.applied ?? [])]).toEqual(["a.txt"]);
    expect(pick.skip).toEqual(["a.txt"]);
    // Only an applied file is left out: nothing stays in the copy, so Apply reads as a whole Apply.
    expect(pick).toMatchObject({ picked: 2, total: 3, partial: false, none: false });

    const unticked = pickOf(files, "new.txt");
    expect(unticked.skip).toEqual(["a.txt", "old.txt", "new.txt"]);
    expect(unticked).toMatchObject({ picked: 1, partial: true });
    // No list yet (the review isn't open): Apply sends nothing, and the main process leaves out what was applied.
    expect(pickOf(null).skip).toBeUndefined();
  });
});
