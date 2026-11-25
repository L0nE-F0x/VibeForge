#!/usr/bin/env node
// @ts-check
// CI's test step. Runs vitest once, writing JSON and JUnit reports beside each other; if the only
// failures are tests listed in tests/flaky.json, runs just those once more. A known flake that then
// passes doesn't fail the job, but it is never silent: it gets a warning on the run, a line in the
// job summary and a record in <reports>/<label>-failures.json (written only when something failed),
// which CI uploads for the weekly report (scripts/flake-report.mjs). Anything else that fails, fails
// the job.
//
//   node scripts/ci-test.mjs --label node-22 [--coverage] [--config vitest.e2e.config.mts] [-- <vitest arguments>]
//
// Reports go to $TEST_REPORTS (default reports/).

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { classify, fullName, knownFlakes, missedFloor, namePattern, summaryMarkdown } from "./flaky.mjs";

const root = path.resolve(import.meta.dirname, "..");
const vitest = path.join(root, "node_modules", "vitest", "vitest.mjs");
const reports = path.resolve(process.env.TEST_REPORTS || path.join(root, "reports"));

const argv = process.argv.slice(2);
const dash = argv.indexOf("--");
const own = dash >= 0 ? argv.slice(0, dash) : argv;
const passed = dash >= 0 ? argv.slice(dash + 1) : [];
const option = (name) => {
  const at = own.indexOf(name);
  return at >= 0 ? own[at + 1] : undefined;
};
const label = option("--label") || "tests";
const config = option("--config");
const coverage = own.includes("--coverage");

/**
 * vitest with its JSON and JUnit reports for this attempt, shown as it runs; its output and code.
 * @param {string[]} args
 * @param {number} attempt
 * @returns {Promise<{ code: number, output: string, json: string }>}
 */
function run(args, attempt) {
  const json = path.join(reports, `${label}-attempt-${attempt}.json`);
  const reporters = ["--reporter=default", "--reporter=json", `--outputFile.json=${json}`, "--reporter=junit", `--outputFile.junit=${path.join(reports, `${label}-attempt-${attempt}.junit.xml`)}`];
  const all = ["run", ...(config ? ["--config", config] : []), ...reporters, ...args];
  console.log(`\n▸ vitest ${all.join(" ")}\n`);
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [vitest, ...all], { cwd: root, stdio: ["inherit", "pipe", "pipe"] });
    let output = "";
    const keep = (/** @type {NodeJS.WriteStream} */ to) => (/** @type {Buffer} */ chunk) => {
      to.write(chunk);
      if (output.length < 4_000_000) output += chunk.toString("utf8");
    };
    child.stdout.on("data", keep(process.stdout));
    child.stderr.on("data", keep(process.stderr));
    child.on("close", (code) => resolve({ code: code ?? 1, output, json }));
  });
}

/** A JSON report, kept without the coverage map vitest puts in it (megabytes the HTML report has anyway). */
function readReport(/** @type {string} */ file) {
  if (!fs.existsSync(file)) return null;
  const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  if (parsed.coverageMap) {
    delete parsed.coverageMap;
    fs.writeFileSync(file, JSON.stringify(parsed));
  }
  return parsed;
}

/** The run's record, its job summary and its warnings. */
function report(/** @type {import("./flaky.mjs").RunRecord} */ record) {
  if (record.failures.length || record.brokenFiles.length) fs.writeFileSync(path.join(reports, `${label}-failures.json`), `${JSON.stringify(record, null, 2)}\n`);
  const summary = summaryMarkdown(record);
  if (summary && process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
  if (summary) console.log(`\n${summary}`);
  for (const item of record.retried) {
    const what = item.passed ? "failed, then passed on retry" : item.rerun ? "failed twice" : "failed, and wasn't retried because other tests failed too";
    const text = `${item.file} › ${item.name} ${what}. Known flaky: ${item.reason} (${item.link})`;
    if (process.env.GITHUB_ACTIONS) console.log(`::warning title=Known flaky test (${label})::${text.replace(/\r?\n/g, " ")}`);
  }
}

fs.mkdirSync(reports, { recursive: true });
const node = process.versions.node.split(".")[0];
const first = await run([...(coverage ? ["--coverage", "--coverage.reportOnFailure"] : []), ...passed], 1);
/** @type {import("./flaky.mjs").RunRecord} */
const record = {
  label,
  node,
  run: process.env.GITHUB_RUN_ID,
  attempt: process.env.GITHUB_RUN_ATTEMPT,
  ref: process.env.GITHUB_HEAD_REF || process.env.GITHUB_REF_NAME,
  sha: process.env.GITHUB_SHA,
  failures: [],
  retried: [],
  real: [],
  brokenFiles: [],
};
const firstReport = readReport(first.json);
if (first.code === 0) {
  report(record);
  process.exit(0);
}

if (!firstReport) {
  console.error(`\n✗ vitest wrote no report (${first.json}); nothing to retry.`);
  report(record);
  process.exit(first.code);
}
const { failures, retry, real, brokenFiles } = classify(firstReport, knownFlakes(), node);
Object.assign(record, { failures, real, brokenFiles });
const floorMissed = coverage && missedFloor(first.output);
if (real.length || brokenFiles.length || floorMissed || retry.length === 0) {
  record.retried = retry.map(({ flake, ...item }) => ({ ...item, rerun: false, passed: false, reason: flake.reason, link: flake.link }));
  report(record);
  if (floorMissed) console.error("\n✗ A coverage floor wasn't met (vitest.config.mts).");
  if (retry.length && (real.length || brokenFiles.length)) console.error("\n✗ Known flaky tests failed alongside other failures, so nothing was retried.");
  process.exit(first.code);
}

// Only known flakes failed: each file's once more, without coverage (the first run already measured it).
console.log(`\n▸ Only known flaky tests failed (${retry.length}); running them once more.`);
const files = [...new Set(retry.map((item) => item.file))];
const second = await run([...files, "-t", namePattern(retry.map((item) => item.name))], 2);
const secondReport = readReport(second.json);
const again = secondReport ? classify(secondReport, [], node).failures : retry;
const ran = secondReport ? new Set((secondReport.testResults ?? []).flatMap((/** @type {import("./flaky.mjs").FileResult} */ file) => (file.assertionResults ?? []).filter((test) => test.status === "passed").map((test) => `${path.relative(root, file.name)} › ${fullName(test)}`))) : new Set();
record.retried = retry.map(({ flake, ...item }) => ({
  ...item,
  rerun: true,
  passed: ran.has(`${item.file} › ${item.name}`) && !again.some((failed) => failed.file === item.file && failed.name === item.name),
  reason: flake.reason,
  link: flake.link,
}));
report(record);
process.exit(second.code === 0 && record.retried.every((item) => item.passed) ? 0 : 1);
