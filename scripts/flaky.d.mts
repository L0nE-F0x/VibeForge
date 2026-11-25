// What scripts/flaky.mjs offers, for tests/unit/flaky.test.ts.
export interface KnownFlake {
  file: string;
  test: string;
  node?: string;
  reason: string;
  link: string;
}
export interface Failure {
  file: string;
  name: string;
}
export interface FileResult {
  name: string;
  status: string;
  message?: string;
  assertionResults?: Array<{ fullName?: string; ancestorTitles?: string[]; title: string; status: string }>;
}
export interface JsonReport {
  testResults?: FileResult[];
}
export interface RunRecord {
  label: string;
  node: string;
  run?: string;
  attempt?: string;
  ref?: string;
  sha?: string;
  failures: Failure[];
  retried: Array<Failure & { rerun: boolean; passed: boolean; reason: string; link: string }>;
  real: Failure[];
  brokenFiles: string[];
}
export interface RunAttempt {
  run: string;
  url?: string;
  attempt: string;
  event?: string;
  ref?: string;
  createdAt?: string;
  failedJobs: string[];
  conclusion: string;
}
export declare const fullName: (test: { fullName?: string; ancestorTitles?: string[]; title: string }) => string;
export declare function knownFlakes(file?: string): KnownFlake[];
export declare function failedTests(report: JsonReport, base?: string): { failures: Failure[]; brokenFiles: string[] };
export declare function knownFor(failure: Failure, flakes: KnownFlake[], nodeMajor?: string): KnownFlake | null;
export declare function classify(report: JsonReport, flakes: KnownFlake[], nodeMajor?: string, base?: string): { failures: Failure[]; retry: Array<Failure & { flake: KnownFlake }>; real: Failure[]; brokenFiles: string[] };
export declare function namePattern(names: string[]): string;
export declare const missedFloor: (output: string) => boolean;
export declare function summaryMarkdown(record: RunRecord): string;
export declare function weeklyReport(input: { records: RunRecord[]; reruns: RunAttempt[]; since: string; until: string; runs: number }): string;
