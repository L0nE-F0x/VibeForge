export type VibyTurnOutcome =
  | "answered"
  | "planned"
  | "executed"
  | "aborted"
  | "timeout"
  | "failed"
  | "noEngine"
  | "signIn"
  | "unreadable";

export interface VibyTurnMetric {
  at: string;
  source: "think" | "quickAct" | "run";
  engineId?: string;
  model?: string;
  warmSession?: boolean;
  repaired?: boolean;
  totalMs: number;
  contextMs?: number;
  plannerMs?: number;
  executionMs?: number;
  outcome: VibyTurnOutcome;
  stepKinds: string[];
  failedSteps: number;
  errorKind?: string;
}

export interface VibyDiagnosticsSummary {
  totalTurns: number;
  errorCount: number;
  warmHits: number;
  repairs: number;
  avgTotalMs: number;
  avgPlannerMs: number;
  p95TotalMs: number;
  recent: VibyTurnMetric[];
}

const ERROR_OUTCOMES = new Set<VibyTurnOutcome>(["timeout", "failed", "noEngine", "signIn", "unreadable"]);

/**
 * Bounded, privacy-safe telemetry buffer for Viby turns and plan runs.
 * Records latency breakdowns, warm-session hits, repairs, and failure categories —
 * never prompts, transcripts, file paths, or terminal output.
 */
export class VibyDiagnostics {
  private entries: VibyTurnMetric[] = [];

  constructor(private readonly cap = 40) {}

  record(metric: VibyTurnMetric): void {
    this.entries.push(metric);
    if (this.entries.length > this.cap) this.entries.splice(0, this.entries.length - this.cap);
  }

  recent(limit = this.cap): VibyTurnMetric[] {
    return this.entries.slice(-Math.max(1, limit));
  }

  summary(): VibyDiagnosticsSummary {
    const totalTurns = this.entries.length;
    if (!totalTurns) {
      return { totalTurns: 0, errorCount: 0, warmHits: 0, repairs: 0, avgTotalMs: 0, avgPlannerMs: 0, p95TotalMs: 0, recent: [] };
    }
    let errorCount = 0;
    let warmHits = 0;
    let repairs = 0;
    let sumTotal = 0;
    let sumPlanner = 0;
    let plannerSamples = 0;
    const totals: number[] = [];
    for (const entry of this.entries) {
      if (ERROR_OUTCOMES.has(entry.outcome) || entry.failedSteps > 0) errorCount += 1;
      if (entry.warmSession) warmHits += 1;
      if (entry.repaired) repairs += 1;
      sumTotal += entry.totalMs;
      totals.push(entry.totalMs);
      if (typeof entry.plannerMs === "number") {
        sumPlanner += entry.plannerMs;
        plannerSamples += 1;
      }
    }
    totals.sort((a, b) => a - b);
    const p95Idx = Math.min(totals.length - 1, Math.floor((totals.length - 1) * 0.95));
    return {
      totalTurns,
      errorCount,
      warmHits,
      repairs,
      avgTotalMs: Math.round(sumTotal / totalTurns),
      avgPlannerMs: plannerSamples ? Math.round(sumPlanner / plannerSamples) : 0,
      p95TotalMs: Math.round(totals[p95Idx] ?? 0),
      recent: this.recent(8),
    };
  }

  formatSummary(extra?: { warmActive?: boolean; cachedContext?: boolean; activeWaits?: number }): string {
    const stats = this.summary();
    const stateBits = [
      extra?.warmActive ? "warm planner ready" : "warm planner idle",
      extra?.cachedContext ? "context cached" : "context cold",
      ...(extra?.activeWaits ? [`${extra.activeWaits} chained wait(s)`] : []),
    ];
    if (!stats.totalTurns) {
      return `Viby diagnostics: no recorded turns yet (${stateBits.join(" · ")}).`;
    }
    const header = `Viby diagnostics (${stats.totalTurns} turn${stats.totalTurns === 1 ? "" : "s"} · ${stats.errorCount} issue${stats.errorCount === 1 ? "" : "s"} · avg ${stats.avgTotalMs}ms · p95 ${stats.p95TotalMs}ms · planner avg ${stats.avgPlannerMs}ms · warm ${stats.warmHits} · repairs ${stats.repairs} · ${stateBits.join(" · ")})`;
    const lines = stats.recent.slice(-5).map((m) => {
      const who = [m.engineId, m.model].filter(Boolean).join("/") || m.source;
      const flags = [m.warmSession ? "warm" : "", m.repaired ? "repaired" : "", m.failedSteps ? `${m.failedSteps} failed` : ""].filter(Boolean);
      const kinds = m.stepKinds.length ? ` [${m.stepKinds.join(",")}]` : "";
      const timing = typeof m.plannerMs === "number" ? `${m.totalMs}ms (plan ${m.plannerMs}ms)` : `${m.totalMs}ms`;
      return `- ${m.at} [${m.source}] ${who}: ${m.outcome} in ${timing}${flags.length ? ` (${flags.join(", ")})` : ""}${kinds}`;
    });
    return [header, ...lines].join("\n");
  }
}

/** Single-line privacy-safe diagnostic summary suitable for `vibeforge.log`. */
export function formatDiagnosticsLogLine(metric: VibyTurnMetric): string {
  const who = [metric.engineId, metric.model].filter(Boolean).join("/") || "none";
  return `Viby [${metric.source}] engine=${who} outcome=${metric.outcome} totalMs=${metric.totalMs}${typeof metric.plannerMs === "number" ? ` plannerMs=${metric.plannerMs}` : ""} warm=${metric.warmSession ? 1 : 0} repaired=${metric.repaired ? 1 : 0} steps=${metric.stepKinds.length} failed=${metric.failedSteps}${metric.errorKind ? ` err=${metric.errorKind}` : ""}`;
}
