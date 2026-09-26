import { execFile } from "node:child_process";
import { dayOf } from "./usage.js";
import { commitDays } from "./vcs.js";

// The contribution graph on Home: a year of days, from your commits in the workspaces (read on
// this machine) or, when you turn it on, from GitHub through the `gh` CLI you are signed in to.
// VibeForge holds no token; `gh` makes the one request.

export type ActivitySource = "off" | "git" | "github";

export interface Activity {
  source: "git" | "github";
  /** One count per day, oldest first: whole weeks from a Sunday, ending today. */
  days: Array<{ day: string; count: number }>;
  total: number;
  /** The GitHub account, for the github source. */
  login: string | null;
  /** Why there is nothing to show, when there isn't. */
  error: string | null;
}

/** 53 weeks of days, Sunday to Saturday, the last week ending today. */
export function calendarDays(now: Date): string[] {
  const start = new Date(now);
  start.setHours(12, 0, 0, 0);
  start.setDate(start.getDate() - start.getDay() - 52 * 7);
  const days: string[] = [];
  const cursor = new Date(start);
  const today = dayOf(now);
  for (;;) {
    const day = dayOf(cursor);
    days.push(day);
    if (day === today) break;
    cursor.setDate(cursor.getDate() + 1);
  }
  return days;
}

function fill(now: Date, counts: Map<string, number>): Array<{ day: string; count: number }> {
  return calendarDays(now).map((day) => ({ day, count: counts.get(day) ?? 0 }));
}

export async function gitActivity(paths: readonly string[], now: Date): Promise<Activity> {
  const days = calendarDays(now);
  const seen = new Set<string>();
  const counts = new Map<string, number>();
  for (const cwd of paths) {
    for (const commit of await commitDays(cwd, `${days[0]} 00:00`)) {
      // Two workspaces in one repository would count its commits twice.
      if (seen.has(commit.hash)) continue;
      seen.add(commit.hash);
      counts.set(commit.day, (counts.get(commit.day) ?? 0) + 1);
    }
  }
  const filled = fill(now, counts);
  return { source: "git", days: filled, total: filled.reduce((sum, item) => sum + item.count, 0), login: null, error: null };
}

const QUERY = "query { viewer { login contributionsCollection { contributionCalendar { totalContributions weeks { contributionDays { date contributionCount } } } } } }";

function gh(args: string[], timeoutMs: number): Promise<{ stdout: string; error: string | null }> {
  return new Promise((resolve) => {
    execFile("gh", args, { timeout: timeoutMs, encoding: "utf8", env: { ...process.env, GH_PROMPT_DISABLED: "1", NO_COLOR: "1" } }, (error, stdout, stderr) => {
      if (!error) return resolve({ stdout, error: null });
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return resolve({ stdout: "", error: "The GitHub CLI (gh) is not installed." });
      if (/auth login|not logged/i.test(stderr)) return resolve({ stdout: "", error: "gh is not signed in. Run `gh auth login` in a terminal." });
      resolve({ stdout: "", error: (stderr || error.message).trim().split("\n")[0] || "gh failed." });
    });
  });
}

/** Parse what the contributions query returns. */
export function parseGithubCalendar(text: string, now: Date): Activity {
  const data = JSON.parse(text) as {
    data?: { viewer?: { login?: string; contributionsCollection?: { contributionCalendar?: { totalContributions?: number; weeks?: Array<{ contributionDays?: Array<{ date?: string; contributionCount?: number }> }> } } } };
  };
  const viewer = data.data?.viewer;
  const calendar = viewer?.contributionsCollection?.contributionCalendar;
  if (!calendar) throw new Error("GitHub sent no contribution calendar.");
  const counts = new Map<string, number>();
  for (const week of calendar.weeks ?? []) {
    for (const day of week.contributionDays ?? []) if (day.date) counts.set(day.date, day.contributionCount ?? 0);
  }
  return { source: "github", days: fill(now, counts), total: calendar.totalContributions ?? 0, login: viewer?.login ?? null, error: null };
}

export async function githubActivity(now: Date): Promise<Activity> {
  const result = await gh(["api", "graphql", "-f", `query=${QUERY}`], 15_000);
  const empty: Activity = { source: "github", days: fill(now, new Map()), total: 0, login: null, error: result.error };
  if (result.error) return empty;
  try {
    return parseGithubCalendar(result.stdout, now);
  } catch (error) {
    return { ...empty, error: error instanceof Error ? error.message : String(error) };
  }
}
