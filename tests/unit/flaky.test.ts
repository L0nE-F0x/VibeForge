import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { classify, fullName, knownFlakes, knownFor, missedFloor, namePattern, type RunRecord, summaryMarkdown, weeklyReport } from "../../scripts/flaky.mjs";

const repo = path.resolve(import.meta.dirname, "..", "..");
const flake = { file: "tests/pty.test.ts", test: "pty host > keeps the tail", node: "22", reason: "libuv 1.51", link: "https://example.invalid/137" };

/** A vitest JSON report with these files' results. */
const report = (files: Array<{ file: string; status?: string; tests: Array<[string[], string, string]> }>) => ({
  testResults: files.map(({ file, status, tests }) => ({
    name: path.join(repo, file),
    status: status ?? (tests.some(([, , state]) => state === "failed") ? "failed" : "passed"),
    assertionResults: tests.map(([ancestorTitles, title, state]) => ({ ancestorTitles, title, fullName: [...ancestorTitles, title].join(" "), status: state })),
  })),
});

describe("the known-flaky list", () => {
  it("names, for each entry, a test that exists, its cause and an https link", () => {
    const list = knownFlakes();
    for (const entry of list) {
      const source = fs.readFileSync(path.join(repo, entry.file), "utf8");
      // The test's own title is in its file, as written.
      expect(source, `${entry.file} has no test called "${entry.test}"`).toContain(JSON.stringify(entry.test.split(" > ").at(-1)).slice(1, -1));
      expect(entry.reason.length).toBeGreaterThan(20);
    }
  });

  it("refuses an entry without a reason or an https link", () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "flaky-")), "flaky.json");
    fs.writeFileSync(file, JSON.stringify({ flaky: [{ ...flake, reason: "" }] }));
    expect(() => knownFlakes(file)).toThrow(/no reason/);
    fs.writeFileSync(file, JSON.stringify({ flaky: [{ ...flake, link: "see the chat" }] }));
    expect(() => knownFlakes(file)).toThrow(/https/);
  });
});

describe("what a failed run's failures mean", () => {
  it("retries only known flakes, on the Node version they are flaky on", () => {
    const run = report([
      { file: "tests/pty.test.ts", tests: [[["pty host"], "keeps the tail", "failed"], [["pty host"], "starts", "passed"]] },
      { file: "tests/unit/other.test.ts", tests: [[[], "works", "passed"]] },
    ]);
    expect(classify(run, [flake], "22", repo)).toMatchObject({ retry: [{ file: "tests/pty.test.ts", name: "pty host > keeps the tail", flake }], real: [], brokenFiles: [] });
    // On Node 24 the same failure is real.
    expect(classify(run, [flake], "24", repo)).toMatchObject({ retry: [], real: [{ file: "tests/pty.test.ts", name: "pty host > keeps the tail" }] });
    // An entry without a Node version is flaky everywhere; another file's test of that name isn't it.
    expect(knownFor({ file: "tests/pty.test.ts", name: "pty host > keeps the tail" }, [{ ...flake, node: undefined }], "26")).toMatchObject({ reason: "libuv 1.51" });
    expect(knownFor({ file: "tests/other.test.ts", name: "pty host > keeps the tail" }, [flake], "22")).toBeNull();
  });

  it("calls a file that failed without a failed test broken, never flaky", () => {
    const run = report([{ file: "tests/unit/broken.test.ts", status: "failed", tests: [] }]);
    expect(classify(run, [flake], "22", repo)).toMatchObject({ failures: [], retry: [], real: [], brokenFiles: ["tests/unit/broken.test.ts"] });
  });

  it("names a test as vitest prints it, and -t finds exactly that one", () => {
    expect(fullName({ ancestorTitles: ["pty host", "held back"], title: "keeps (all) of it?", fullName: "pty host held back keeps (all) of it?" })).toBe("pty host > held back > keeps (all) of it?");
    const pattern = new RegExp(namePattern(["pty host > keeps (all) of it?", "a > b"]));
    expect(pattern.test("pty host > keeps (all) of it?")).toBe(true);
    expect(pattern.test("a > b")).toBe(true);
    expect(pattern.test("pty host > keeps (all) of it? too")).toBe(false);
    expect(pattern.test("pty host > keeps all of it")).toBe(false);
  });

  it("notices a coverage floor that wasn't met", () => {
    expect(missedFloor('ERROR: Coverage for lines (84.2%) does not meet "src/core/**" threshold (85%)')).toBe(true);
    expect(missedFloor("Coverage for lines (90%)\n Test Files 3 passed")).toBe(false);
  });
});

const record = (over: Partial<RunRecord>): RunRecord => ({ label: "node-22", node: "22", run: "1", failures: [], retried: [], real: [], brokenFiles: [], ...over });

describe("what CI says about it", () => {
  it("says nothing in the job summary when everything passed the first time", () => {
    expect(summaryMarkdown(record({}))).toBe("");
  });

  it("lists a flake that passed on retry with its cause, and a real failure plainly", () => {
    const text = summaryMarkdown(
      record({
        failures: [{ file: "tests/pty.test.ts", name: "pty host > keeps the tail" }, { file: "tests/a.test.ts", name: "a" }],
        retried: [{ file: "tests/pty.test.ts", name: "pty host > keeps the tail", rerun: true, passed: true, reason: "libuv 1.51", link: "https://example.invalid/137" }],
        real: [{ file: "tests/a.test.ts", name: "a" }],
      }),
    );
    expect(text).toContain("Known flaky, passed on retry: `tests/pty.test.ts` › pty host > keeps the tail ([why](https://example.invalid/137): libuv 1.51)");
    expect(text).toContain("Failed: `tests/a.test.ts` › a");
    // Beside a real failure, a known flake isn't run again, and the summary says so.
    const beside = summaryMarkdown(record({ failures: [{ file: "x", name: "y" }], retried: [{ file: "x", name: "y", rerun: false, passed: false, reason: "r", link: "https://example.invalid" }] }));
    expect(beside).toContain("Known flaky, not retried as other tests failed: `x` › y");
  });

  it("counts each test by the runs it failed in, most often first, and lists re-run jobs", () => {
    const tail = { file: "tests/pty.test.ts", name: "pty host > keeps the tail", reason: "libuv 1.51", link: "https://example.invalid/137" };
    const text = weeklyReport({
      since: "2026-11-18",
      until: "2026-11-25",
      runs: 40,
      records: [
        record({ run: "1", failures: [tail], retried: [{ ...tail, rerun: true, passed: true }] }),
        record({ run: "2", failures: [tail], retried: [{ ...tail, rerun: true, passed: false }] }),
        record({ run: "2", label: "node-24", failures: [{ file: "tests/b.test.ts", name: "b" }], real: [{ file: "tests/b.test.ts", name: "b" }] }),
      ],
      reruns: [
        { run: "9", url: "https://example.invalid/run/9", attempt: "1", ref: "main", failedJobs: ["e2e"], conclusion: "success" },
        { run: "10", attempt: "1", failedJobs: [], conclusion: "success" },
      ],
    });
    const rows = text.split("\n").filter((line) => line.startsWith("| `"));
    expect(rows).toEqual([
      "| `tests/pty.test.ts` › pty host > keeps the tail | 2 | 1 | 1 | [yes](https://example.invalid/137) |",
      "| `tests/b.test.ts` › b | 1 | 0 | 1 | no |",
    ]);
    expect(text).toContain("across 40 CI runs");
    expect(text).toContain("- [run 9](https://example.invalid/run/9), attempt 1 on `main`: e2e");
    expect(text).not.toContain("run 10");
  });

  it("says None when the week was clean", () => {
    const text = weeklyReport({ since: "2026-11-18", until: "2026-11-25", runs: 1, records: [], reruns: [] });
    expect(text.match(/^None\.$/gm)).toHaveLength(2);
    expect(text).toContain("across 1 CI run.");
  });
});
