import { readJson, writeJson } from "./fsx.js";
import type { PlanId, PlanSummary } from "./plans.js";

/** The shares of a plan window worth a notification. */
export const QUOTA_STEPS = [80, 95, 100] as const;
/** A reading older than this is last session's news, not something to announce. */
const FRESH_MS = 15 * 60 * 1000;

export const PLAN_NAMES: Record<PlanId, string> = { claude: "Claude", codex: "Codex", grok: "Grok", kimi: "Kimi" };

export interface QuotaAlert {
  plan: PlanId;
  /** The window as the provider names it ("5-hour", "Weekly"). */
  window: string;
  step: (typeof QUOTA_STEPS)[number];
  percent: number;
  resetsAt: string | null;
}

interface Seen {
  /** The step already announced in this window. */
  step: number;
  /** Which window that was: a new reset time is a new window, and announcements start again. */
  resetsAt: string | null;
}

/**
 * Notifications as a plan window passes 80, 95 and 100 percent: each step once per window, and
 * only the highest one reached when several are passed between two readings. What was announced
 * is kept on disk, so a restart doesn't announce it again.
 */
export class QuotaAlerts {
  private seen: Record<string, Seen>;

  constructor(
    private readonly file: string,
    private readonly now: () => number = Date.now,
  ) {
    const saved = readJson<Record<string, Seen> | null>(file, null);
    this.seen = saved && typeof saved === "object" ? saved : {};
  }

  /** The announcements a new summary calls for. Remembers them as made. */
  check(summary: PlanSummary): QuotaAlert[] {
    const now = this.now();
    const alerts: QuotaAlert[] = [];
    let changed = false;
    for (const provider of summary.providers) {
      if (provider.problem || !provider.readAt || now - Date.parse(provider.readAt) > FRESH_MS) continue;
      for (const window of provider.windows) {
        if (window.resetsAt && Date.parse(window.resetsAt) <= now) continue;
        const key = `${provider.id}|${window.name}`;
        const before = this.seen[key];
        const newWindow = !before || !sameWindow(before.resetsAt, window.resetsAt);
        const current: Seen = newWindow ? { step: 0, resetsAt: window.resetsAt } : before;
        const reached = [...QUOTA_STEPS].reverse().find((step) => window.percent >= step);
        if (reached && reached > current.step) {
          alerts.push({ plan: provider.id, window: window.name, step: reached, percent: window.percent, resetsAt: window.resetsAt });
          current.step = reached;
          changed = true;
        }
        if (newWindow) {
          this.seen[key] = current;
          changed = true;
        }
      }
    }
    if (changed) {
      try {
        writeJson(this.file, this.seen);
      } catch {
        /* at worst a step is announced again after a restart */
      }
    }
    return alerts;
  }
}

/**
 * Whether two reset times name the same window. Codex's is worked out from "resets in N seconds"
 * in its log, so it wanders by a few seconds between readings; windows are hours apart.
 */
function sameWindow(a: string | null, b: string | null): boolean {
  if (!a || !b) return a === b;
  return Math.abs(Date.parse(a) - Date.parse(b)) < 10 * 60 * 1000;
}

/** A notification's words for an alert. `now` is for the time left until the reset. */
export function quotaNote(alert: QuotaAlert, now: number): { title: string; body: string } {
  const name = PLAN_NAMES[alert.plan];
  const title = alert.step >= 100 ? `${name}: the ${alert.window} limit is reached` : `${name}: ${Math.floor(alert.percent)}% of the ${alert.window} limit used`;
  if (!alert.resetsAt) return { title, body: "" };
  const minutes = Math.max(1, Math.round((Date.parse(alert.resetsAt) - now) / 60_000));
  const left = minutes < 60 ? `${minutes}m` : minutes < 48 * 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` : `${Math.round(minutes / 60 / 24)} days`;
  return { title, body: `Resets in ${left}.` };
}
