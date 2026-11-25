#!/usr/bin/env node
// @ts-check
// The weekly flaky-test report (.github/workflows/flaky-report.yml). It reads, through the gh CLI:
//   - each `test-failures-*` artifact of the last week: what failed in a test step, and which known
//     flakes passed on their retry (written by scripts/ci-test.mjs only when something failed);
//   - every CI run that needed a second attempt: the jobs that failed on the attempts before.
// Then it opens one issue labelled `flaky-tests`, or rewrites the open one, with the table.
//
//   node scripts/flake-report.mjs [--days 7] [--dry-run]
//
// --dry-run prints the report instead of touching an issue. GH_TOKEN (or gh's own login) needs
// actions: read and issues: write; GITHUB_REPOSITORY names the repository (else gh works it out).

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { weeklyReport } from "./flaky.mjs";

const argv = process.argv.slice(2);
const days = Number(argv[argv.indexOf("--days") + 1]) || 7;
const dryRun = argv.includes("--dry-run");
const LABEL = "flaky-tests";
const TITLE = "Flaky tests: weekly report";

const gh = (/** @type {string[]} */ args, /** @type {{ binary?: boolean }} */ opts = {}) => execFileSync("gh", args, { encoding: opts.binary ? "buffer" : "utf8", maxBuffer: 256 * 1024 * 1024 });
/** Each JSON value `gh api --paginate --jq` prints, one per line. */
const lines = (/** @type {string} */ text) =>
  text
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));

const repo = process.env.GITHUB_REPOSITORY || String(gh(["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"])).trim();
const until = new Date();
const since = new Date(until.getTime() - days * 86_400_000);
const day = (/** @type {Date} */ date) => date.toISOString().slice(0, 10);

// What failed in test steps: the small artifacts ci-test.mjs leaves only when something did.
/** @type {Array<{ id: number, name: string, created_at: string, expired: boolean }>} */
const artifacts = lines(String(gh(["api", "--paginate", `repos/${repo}/actions/artifacts?per_page=100`, "--jq", '.artifacts[] | select(.name | startswith("test-failures-")) | {id, name, created_at, expired}']))).filter(
  (artifact) => !artifact.expired && Date.parse(artifact.created_at) >= since.getTime(),
);
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "flake-report-"));
/** @type {import("./flaky.mjs").RunRecord[]} */
const records = [];
for (const artifact of artifacts) {
  const zip = path.join(scratch, `${artifact.id}.zip`);
  fs.writeFileSync(zip, gh(["api", `repos/${repo}/actions/artifacts/${artifact.id}/zip`], { binary: true }));
  const out = path.join(scratch, String(artifact.id));
  execFileSync("unzip", ["-q", "-o", zip, "-d", out]);
  for (const file of fs.readdirSync(out, { recursive: true, encoding: "utf8" })) {
    if (file.endsWith("-failures.json")) records.push(JSON.parse(fs.readFileSync(path.join(out, file), "utf8")));
  }
}

// Runs that needed another attempt: which jobs failed before someone pressed Re-run.
/** @type {Array<{ id: number, run_attempt: number, event: string, head_branch: string, html_url: string, created_at: string, conclusion: string | null, path: string }>} */
const runs = lines(String(gh(["api", "--paginate", `repos/${repo}/actions/runs?per_page=100&created=>=${day(since)}`, "--jq", ".workflow_runs[] | {id, run_attempt, event, head_branch, html_url, created_at, conclusion, path}"]))).filter((run) =>
  /\.github\/workflows\/(ci|nightly)\.yml$/.test(run.path),
);
/** @type {import("./flaky.mjs").RunAttempt[]} */
const reruns = [];
for (const run of runs.filter((item) => item.run_attempt > 1)) {
  for (let attempt = 1; attempt < run.run_attempt; attempt += 1) {
    // "test" only says whether the Node versions passed; the version that failed is named on its own.
    const failedJobs = lines(String(gh(["api", `repos/${repo}/actions/runs/${run.id}/attempts/${attempt}/jobs?per_page=100`, "--jq", '.jobs[] | select(.conclusion == "failure" and .name != "test") | .name | tojson']))).map(String);
    reruns.push({ run: String(run.id), url: run.html_url, attempt: String(attempt), event: run.event, ref: run.head_branch, createdAt: run.created_at, failedJobs, conclusion: run.conclusion ?? "" });
  }
}
fs.rmSync(scratch, { recursive: true, force: true });

const body = weeklyReport({ records, reruns, since: day(since), until: day(until), runs: runs.length });
if (dryRun) {
  console.log(body);
  process.exit(0);
}

const open = String(gh(["issue", "list", "--repo", repo, "--label", LABEL, "--state", "open", "--json", "number", "--jq", ".[0].number // empty"])).trim();
const quiet = !records.length && !reruns.some((attempt) => attempt.failedJobs.length);
const bodyFile = path.join(os.tmpdir(), `flake-report-${process.pid}.md`);
fs.writeFileSync(bodyFile, body);
if (open) {
  gh(["issue", "edit", open, "--repo", repo, "--body-file", bodyFile]);
  console.log(`Updated #${open}.`);
} else if (quiet) {
  console.log("Nothing failed this week, and no report is open: nothing to do.");
} else {
  gh(["label", "create", LABEL, "--repo", repo, "--color", "d93f0b", "--description", "Tests that failed, then passed, in CI", "--force"]);
  console.log(String(gh(["issue", "create", "--repo", repo, "--title", TITLE, "--label", LABEL, "--body-file", bodyFile])).trim());
}
fs.rmSync(bodyFile, { force: true });
