// @ts-check
// Known flaky tests (tests/flaky.json): which failures of a run they explain, how to run only those
// again, and what each CI run and the weekly report say about them. Used by scripts/ci-test.mjs,
// scripts/flake-report.mjs and tests/unit/flaky.test.ts.

import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");

/**
 * @typedef {{ file: string, test: string, node?: string, reason: string, link: string }} KnownFlake
 * @typedef {{ file: string, name: string }} Failure
 * @typedef {{ name: string, status: string, message?: string, assertionResults?: Array<{ fullName?: string, ancestorTitles?: string[], title: string, status: string }> }} FileResult
 * @typedef {{ testResults?: FileResult[] }} JsonReport
 */

/** The known-flaky list, checked: each entry needs a file, a test, a reason and a link. */
export function knownFlakes(file = path.join(root, "tests", "flaky.json")) {
  const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  /** @type {KnownFlake[]} */
  const list = Array.isArray(parsed?.flaky) ? parsed.flaky : [];
  for (const entry of list) {
    for (const field of /** @type {const} */ (["file", "test", "reason", "link"])) {
      if (typeof entry?.[field] !== "string" || !entry[field].trim()) throw new Error(`tests/flaky.json: an entry has no ${field}: ${JSON.stringify(entry)}`);
    }
    if (!/^https:\/\//.test(entry.link)) throw new Error(`tests/flaky.json: ${entry.test}'s link isn't an https address`);
  }
  return list;
}

/** A test's full name as vitest prints it and as -t matches it: describe blocks and title, joined by " > ". */
export const fullName = (/** @type {{ fullName?: string, ancestorTitles?: string[], title: string }} */ test) => (test.ancestorTitles ? [...test.ancestorTitles, test.title].join(" > ") : test.fullName || test.title);

/** Every failed test in a vitest JSON report, by file relative to the repository. */
export function failedTests(/** @type {JsonReport} */ report, base = root) {
  /** @type {Failure[]} */
  const failures = [];
  /** Files that failed with no failed test in them: a file that didn't load, a hook that threw. */
  const brokenFiles = [];
  for (const file of report.testResults ?? []) {
    const relative = path.relative(base, file.name) || file.name;
    const failed = (file.assertionResults ?? []).filter((test) => test.status === "failed");
    for (const test of failed) failures.push({ file: relative, name: fullName(test) });
    if (file.status === "failed" && failed.length === 0) brokenFiles.push(relative);
  }
  return { failures, brokenFiles };
}

/** The entry that explains this failure on this Node version, if any. */
export function knownFor(/** @type {Failure} */ failure, /** @type {KnownFlake[]} */ flakes, nodeMajor = process.versions.node.split(".")[0]) {
  return flakes.find((entry) => entry.file === failure.file && entry.test === failure.name && (!entry.node || entry.node === nodeMajor)) ?? null;
}

/**
 * What a failed run's failures mean: `retry` holds the known flakes, worth running once more, and
 * `real` everything else. A run is retried only when `real` and `brokenFiles` are both empty.
 */
export function classify(/** @type {JsonReport} */ report, /** @type {KnownFlake[]} */ flakes, nodeMajor = process.versions.node.split(".")[0], base = root) {
  const { failures, brokenFiles } = failedTests(report, base);
  /** @type {Array<Failure & { flake: KnownFlake }>} */
  const retry = [];
  /** @type {Failure[]} */
  const real = [];
  for (const failure of failures) {
    const flake = knownFor(failure, flakes, nodeMajor);
    if (flake) retry.push({ ...failure, flake });
    else real.push(failure);
  }
  return { failures, retry, real, brokenFiles };
}

/** A -t pattern that matches exactly these full test names. */
export function namePattern(/** @type {string[]} */ names) {
  return `^(?:${names.map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})$`;
}

/** Whether vitest's output says a coverage floor wasn't met. */
export const missedFloor = (/** @type {string} */ output) => /Coverage for \w+ \([\d.]+%\) does not meet .*threshold/.test(output);

/**
 * A test step's failures. `retried` holds the known flakes among them: `rerun` when they were run
 * again (only when nothing else failed), and `passed` when that second run passed.
 * @typedef {{ label: string, node: string, run?: string, attempt?: string, ref?: string, sha?: string, failures: Failure[], retried: Array<Failure & { rerun: boolean, passed: boolean, reason: string, link: string }>, real: Failure[], brokenFiles: string[] }} RunRecord
 */

/** The job summary's section for one test step: nothing when everything passed the first time. */
export function summaryMarkdown(/** @type {RunRecord} */ record) {
  if (!record.failures.length && !record.brokenFiles.length) return "";
  const lines = [`### Tests that failed in ${record.label}`, ""];
  const state = (/** @type {{ rerun: boolean, passed: boolean }} */ item) => (item.passed ? "Known flaky, passed on retry" : item.rerun ? "Known flaky, failed again" : "Known flaky, not retried as other tests failed");
  for (const item of record.retried) lines.push(`- ${state(item)}: \`${item.file}\` › ${item.name} ([why](${item.link}): ${item.reason})`);
  for (const item of record.real) lines.push(`- Failed: \`${item.file}\` › ${item.name}`);
  for (const file of record.brokenFiles) lines.push(`- Failed to run: \`${file}\``);
  return `${lines.join("\n")}\n`;
}

/**
 * @typedef {{ run: string, url?: string, attempt: string, event?: string, ref?: string, createdAt?: string, failedJobs: string[], conclusion: string }} RunAttempt
 */

/**
 * The weekly report: every test retried by ci-test.mjs, every test that failed in a run, and each
 * job that failed on an attempt someone then re-ran. Tests are counted by run, most frequent first.
 */
export function weeklyReport(/** @type {{ records: RunRecord[], reruns: RunAttempt[], since: string, until: string, runs: number }} */ input) {
  /** @type {Map<string, { file: string, name: string, retried: number, passedOnRetry: number, failed: number, runs: Set<string>, reason?: string, link?: string }>} */
  const tests = new Map();
  for (const record of input.records) {
    const seen = (/** @type {Failure} */ item) => {
      const key = `${item.file} › ${item.name}`;
      const row = tests.get(key) ?? { file: item.file, name: item.name, retried: 0, passedOnRetry: 0, failed: 0, runs: new Set() };
      tests.set(key, row);
      if (record.run) row.runs.add(record.run);
      return row;
    };
    for (const item of record.retried) {
      const row = seen(item);
      row.retried += 1;
      if (item.passed) row.passedOnRetry += 1;
      else row.failed += 1;
      row.reason = item.reason;
      row.link = item.link;
    }
    for (const item of record.real) seen(item).failed += 1;
  }
  const rows = [...tests.values()].sort((a, b) => b.runs.size - a.runs.size || b.retried - a.retried || a.name.localeCompare(b.name));
  const out = [`Flaky tests from ${input.since} to ${input.until}, across ${input.runs} CI run${input.runs === 1 ? "" : "s"}. Made by \`.github/workflows/flaky-report.yml\`; updated each week.`, ""];
  out.push("## Tests that failed", "");
  if (!rows.length) out.push("None.");
  else {
    out.push("| Test | Runs | Retried, then passed | Failed | Known flaky |", "| --- | --- | --- | --- | --- |");
    for (const row of rows) out.push(`| \`${row.file}\` › ${row.name.replaceAll("|", "\\|")} | ${row.runs.size} | ${row.passedOnRetry} | ${row.failed} | ${row.link ? `[yes](${row.link})` : "no"} |`);
  }
  out.push("", "A test that failed and isn't known flaky either broke for real in that run or is a new flake: look at the run before adding it to `tests/flaky.json`.", "");
  out.push("## Jobs that failed, then passed when re-run", "");
  const reruns = input.reruns.filter((attempt) => attempt.failedJobs.length);
  if (!reruns.length) out.push("None.");
  else for (const attempt of reruns) out.push(`- ${attempt.url ? `[run ${attempt.run}](${attempt.url})` : `run ${attempt.run}`}, attempt ${attempt.attempt}${attempt.ref ? ` on \`${attempt.ref}\`` : ""}: ${attempt.failedJobs.join(", ")}`);
  return `${out.join("\n")}\n`;
}
