import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { calendarDays, gitActivity, parseGithubCalendar } from "../../src/core/activity.js";
import { contributionLevels } from "../../src/ui/components/Pixel.js";

const NOW = new Date(2026, 8, 26, 21, 0, 0); // a Saturday

describe("activity", () => {
  it("lays out 53 weeks from a Sunday, ending today", () => {
    const days = calendarDays(NOW);
    expect(days.at(-1)).toBe("2026-09-26");
    expect(new Date(`${days[0]}T12:00:00`).getDay()).toBe(0);
    expect(days).toHaveLength(53 * 7);
    expect(calendarDays(new Date(2026, 8, 27, 9))).toHaveLength(52 * 7 + 1);
  });

  it("reads GitHub's contribution calendar", () => {
    const text = JSON.stringify({
      data: { viewer: { login: "someone", contributionsCollection: { contributionCalendar: { totalContributions: 7, weeks: [{ contributionDays: [{ date: "2026-09-25", contributionCount: 3 }, { date: "2026-09-26", contributionCount: 4 }] }] } } } },
    });
    const activity = parseGithubCalendar(text, NOW);
    expect(activity).toMatchObject({ source: "github", total: 7, login: "someone", error: null });
    expect(activity.days.slice(-2)).toEqual([
      { day: "2026-09-25", count: 3 },
      { day: "2026-09-26", count: 4 },
    ]);
    expect(() => parseGithubCalendar("{}", NOW)).toThrow(/no contribution calendar/);
  });

  it("counts your commits in the workspaces once, even when two share a repository", async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "vibeforge-activity-"));
    const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, env: { ...process.env, GIT_AUTHOR_DATE: "2026-09-20T10:00:00", GIT_COMMITTER_DATE: "2026-09-20T10:00:00" } });
    git("init", "-q");
    git("config", "user.email", "me@example.com");
    git("config", "user.name", "Me");
    git("commit", "-q", "--allow-empty", "-m", "mine");
    git("-c", "user.email=other@example.com", "commit", "-q", "--allow-empty", "--author", "Other <other@example.com>", "-m", "theirs");
    const activity = await gitActivity([repo, path.join(repo, ".")], NOW);
    expect(activity.total).toBe(1);
    expect(activity.days.find((item) => item.day === "2026-09-20")?.count).toBe(1);
  });

  it("steps busy days by quartile", () => {
    const level = contributionLevels([0, 1, 2, 3, 4, 50]);
    expect([0, 1, 2, 3, 4, 50].map(level)).toEqual([0, 1, 1, 2, 3, 4]);
  });
});
