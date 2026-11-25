import { describe, expect, it } from "vitest";
import { diffFiles } from "../../src/ui/diff-files.js";

describe("the files a diff touches", () => {
  it("lists each file with its added and removed lines, ignoring the headers", () => {
    const text = [
      "diff --git a/src/app.ts b/src/app.ts",
      "index 1111111..2222222 100644",
      "--- a/src/app.ts",
      "+++ b/src/app.ts",
      "@@ -1,2 +1,3 @@",
      "-export const a = 1;",
      "+export const a = 2;",
      "+export const b = 3;",
      " // end",
      "diff --git a/notes.txt b/notes.txt",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/notes.txt",
      "@@ -0,0 +1 @@",
      "+x",
    ].join("\n");
    expect(diffFiles(text)).toEqual([
      { path: "src/app.ts", added: 2, removed: 1, line: 0 },
      { path: "notes.txt", added: 1, removed: 0, line: 9 },
    ]);
  });

  it("counts a changed line that starts with dashes or pluses, which only headers do before a hunk", () => {
    const text = [
      "diff --git a/README.md b/README.md",
      "index 1111111..2222222 100644",
      "--- a/README.md",
      "+++ b/README.md",
      "@@ -1,4 +1,4 @@",
      " # Title",
      "----",
      "+===",
      "--- a comment",
      "+++counter;",
      "diff --git a/b.sql b/b.sql",
      "--- a/b.sql",
      "+++ b/b.sql",
      "@@ -1 +1 @@",
      "--- old",
      "+++ new",
    ].join("\n");
    expect(diffFiles(text)).toEqual([
      { path: "README.md", added: 2, removed: 2, line: 0 },
      { path: "b.sql", added: 1, removed: 1, line: 10 },
    ]);
  });

  it("has nothing to list for an empty diff", () => {
    expect(diffFiles("")).toEqual([]);
  });
});
