import type { UsageSource, UsageSummary } from "../../shared/api.js";
import { useEngines } from "../api.js";
import { useT } from "../i18n/index.js";
import { BlockBars } from "./Pixel.js";

// Token usage from the CLIs' own logs: a few squares under the rail's live button, and a
// breakdown in its popover. Tokens count everything a model read and wrote, cache included.

const METER = 6;

export function compactTokens(value: number, language: string): string {
  return new Intl.NumberFormat(language, { notation: "compact", maximumFractionDigits: value >= 1e9 ? 2 : 1 }).format(value);
}

/** Today's tokens across every CLI, and the busiest day of the week for scale. */
export function usageToday(summary: UsageSummary | null | undefined): { today: number; peak: number } {
  const days = summary?.sources.map((source) => source.days) ?? [];
  const perDay = days.length ? days[0].map((_, index) => days.reduce((sum, row) => sum + (row[index] ?? 0), 0)) : [];
  return { today: perDay.at(-1) ?? 0, peak: Math.max(0, ...perDay) };
}

/** Squares lit by how today compares with the busiest day this week. */
export function UsageMeter({ summary }: { summary: UsageSummary | null | undefined }) {
  const { today, peak } = usageToday(summary);
  if (!summary?.sources.length) return null;
  const lit = today ? Math.max(1, Math.round((today / Math.max(peak, 1)) * METER)) : 0;
  const hot = summary.sources.some((source) => source.limits.some((limit) => limit.usedPercent >= 80));
  return (
    <span className={`usage-meter${hot ? " hot" : ""}`} aria-hidden>
      {Array.from({ length: METER }, (_, index) => (
        <i key={index} className={index < lit ? "on" : undefined} />
      ))}
    </span>
  );
}

function windowLabel(minutes: number, t: ReturnType<typeof useT>): string {
  if (minutes >= 10_080 && minutes % 10_080 === 0) return t("usage.window.week");
  if (minutes >= 60 && minutes % 60 === 0) return t("usage.window.hours", { hours: minutes / 60 });
  return t("usage.window.minutes", { minutes });
}

function SourceRow({ source, label }: { source: UsageSource; label: string }) {
  const t = useT();
  const cached = source.today.total ? Math.round((source.today.cached / source.today.total) * 100) : 0;
  const time = (iso: string) => new Date(iso).toLocaleTimeString(t.language, { hour: "2-digit", minute: "2-digit" });
  return (
    <div className="usage-source">
      <div className="usage-head">
        <span className="truncate" style={{ color: "var(--fg)" }}>
          {label}
        </span>
        <span className="grow" />
        <b>{compactTokens(source.today.total, t.language)}</b>
      </div>
      <div className="usage-sub">
        <span className="truncate">
          {source.today.total ? t("usage.cached", { percent: cached }) : t("usage.quietToday")}
          {source.models[0] ? ` · ${source.models[0].model}` : ""}
        </span>
        <span className="grow" />
        <BlockBars values={source.days} rows={4} label={t("usage.week", { total: compactTokens(source.week.total, t.language) })} />
      </div>
      {source.limits.map((limit) => (
        <div key={limit.windowMinutes} className={`usage-limit${limit.usedPercent >= 80 ? " hot" : ""}`}>
          <span>{windowLabel(limit.windowMinutes, t)}</span>
          <span className="usage-track">
            <i style={{ width: `${limit.usedPercent}%` }} />
          </span>
          <span>{Math.round(limit.usedPercent)}%</span>
          {limit.resetsAt && <span className="faint">{t("usage.resets", { time: time(limit.resetsAt) })}</span>}
        </div>
      ))}
    </div>
  );
}

export function UsagePanel({ summary }: { summary: UsageSummary | null | undefined }) {
  const t = useT();
  const engines = useEngines().data ?? [];
  if (!summary) return null;
  const label = (id: string) => engines.find((engine) => engine.id === id)?.label ?? id;
  return (
    <div className="usage-panel">
      <div className="list-label">{t("usage.title")}</div>
      {summary.sources.length === 0 && <div className="faint usage-note">{t("usage.none")}</div>}
      {[...summary.sources]
        .sort((a, b) => b.today.total - a.today.total)
        .map((source) => (
          <SourceRow key={source.id} source={source} label={label(source.id)} />
        ))}
      <div className="faint usage-note">{t("usage.note")}</div>
    </div>
  );
}
