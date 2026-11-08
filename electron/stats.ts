import os from "node:os";
import path from "node:path";
import { gitActivity, githubActivity, type Activity, type ActivitySource } from "../src/core/activity.js";
import { PlanWatcher } from "../src/core/plans.js";
import { quotaNote, QuotaAlerts } from "../src/core/quota-alerts.js";
import { UsageScanner } from "../src/core/usage.js";
import type { MainContext } from "./main-context.js";
import type { Notify } from "./notify.js";

// What VibeForge reads about your work: token usage, plan limits (with their alerts) and the
// activity graph, for the window and the phone page.

/** The graph changes slowly: git is read again after 5 minutes, GitHub after 30. */
export class ActivityCache {
  private last: { key: string; at: number; value: Promise<Activity> } | null = null;

  constructor(
    private readonly read: (source: "git" | "github", paths: string[], now: Date) => Promise<Activity>,
    private readonly clock: () => number = Date.now,
  ) {}

  get(source: "git" | "github", paths: string[], fresh: boolean): Promise<Activity> {
    // Adding or removing a workspace changes what git counts.
    const key = source === "github" ? source : `${source}:${paths.join("\n")}`;
    const maxAge = source === "github" ? 30 * 60_000 : 5 * 60_000;
    if (!fresh && this.last?.key === key && this.clock() - this.last.at < maxAge) return this.last.value;
    const value = this.read(source, paths, new Date());
    this.last = { key, at: this.clock(), value };
    return value;
  }
}

export class Stats {
  readonly usage: UsageScanner;
  private readonly plans: PlanWatcher;
  /** What was already announced about plan limits, so each step is told once per window. */
  private readonly quotaAlerts: QuotaAlerts;
  private readonly activity: ActivityCache;

  constructor(
    private readonly ctx: MainContext,
    private readonly notify: Notify,
    version: string,
  ) {
    const { dataRoot } = ctx.roots;
    this.usage = new UsageScanner(os.homedir(), { ledger: path.join(dataRoot, "usage-days.json") });
    this.plans = new PlanWatcher({ home: os.homedir(), file: path.join(dataRoot, "plans.json"), agent: `VibeForge/${version}` });
    this.quotaAlerts = new QuotaAlerts(path.join(dataRoot, "quota-alerts.json"));
    this.activity = new ActivityCache((source, paths, now) =>
      source === "github"
        ? githubActivity(now).then((result) => {
            ctx.log.info(result.error ? `GitHub activity not read: ${result.error}` : "GitHub activity read");
            return result;
          })
        : gitActivity(paths, now),
    );
  }

  /** Plan limits, from the CLIs' own files and (when Settings allow) the network; null when neither is on. */
  async planSummary(fresh: boolean) {
    const { ctx } = this;
    const settings = ctx.svc().getSettings();
    const local = settings.usage
      ? (await this.usage.scan()).sources.filter((source) => source.limits.length).map((source) => ({ id: source.id, limits: source.limits, at: source.limitsAt }))
      : [];
    if (!settings.planLimits && !local.length) return null;
    const summary = await this.plans.summary({ network: settings.planLimits, local, fresh });
    if (settings.quotaAlerts && settings.notify) {
      for (const alert of this.quotaAlerts.check(summary)) {
        ctx.log.info(`Plan alert: ${alert.plan} ${alert.window} at ${Math.floor(alert.percent)}%`);
        this.notify(quotaNote(alert, Date.now(), ctx.words.alerts()));
      }
    }
    return summary;
  }

  /** The activity graph from the workspaces' git history or from GitHub; null when it is off. */
  activityFor(source: ActivitySource, fresh: boolean): Promise<Activity> | null {
    if (source === "off" || !this.ctx.service) return null;
    const paths = this.ctx.service.listWorkspaces().workspaces.map((workspace) => workspace.path);
    return this.activity.get(source, paths, fresh);
  }
}
