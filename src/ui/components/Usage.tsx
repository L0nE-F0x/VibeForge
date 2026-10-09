import { useMemo, useState, type ReactNode } from "react";
import { RefreshCw } from "lucide-react";
import type { PlanId, PlanPoint, PlanProvider, PlanSummary, UsagePeriod, UsageSource, UsageSummary } from "../../shared/api.js";
import { planMark } from "../../shared/pixel.js";
import { useEngines, useNow } from "../api.js";
import { useT } from "../i18n/index.js";
import { BlockBars } from "./Pixel.js";
import { tipProps } from "./Tooltip.js";
import { Button } from "./ui.js";

// Usage in the rail's live popover. Plan limits: how much of each coding plan's windows is used,
// the way the Omarchy bar's AI usage widget shows them. Tokens: what the CLIs' own logs add up
// to, cache included. A few squares under the live button follow the hottest plan, or today's
// tokens when no plan reports limits.

const METER = 6;

export const PLAN_NAMES: Record<PlanId, string> = { claude: "Claude", codex: "Codex", grok: "Grok", kimi: "Kimi", muse: "Muse" };

export function compactTokens(value: number, language: string): string {
  return new Intl.NumberFormat(language, { notation: "compact", maximumFractionDigits: value >= 1e9 ? 2 : 1 }).format(value);
}

/** Today's tokens across every CLI, and the busiest day of the week for scale. */
export function usageToday(summary: UsageSummary | null | undefined): { today: number; peak: number } {
  const days = summary?.sources.map((source) => source.periods.week.bars) ?? [];
  const perDay = days.length ? days[0].map((_, index) => days.reduce((sum, row) => sum + (row[index] ?? 0), 0)) : [];
  return { today: perDay.at(-1) ?? 0, peak: Math.max(0, ...perDay) };
}

/** The plan closest to its limit, which the rail follows; of two full plans, the one blocked longer. */
export function hottestPlan(plans: PlanSummary | null | undefined): PlanProvider | null {
  let best: PlanProvider | null = null;
  const until = (provider: PlanProvider) => (provider.resetsAt ? Date.parse(provider.resetsAt) : 0);
  for (const provider of plans?.providers ?? []) {
    if (provider.percent === null) continue;
    if (!best || provider.percent > (best.percent ?? -1) || (provider.percent === best.percent && until(provider) > until(best))) best = provider;
  }
  return best;
}

type Level = "quiet" | "warm" | "full";
const levelOf = (percent: number | null): Level => (percent === null || percent < 80 ? "quiet" : percent < 100 ? "warm" : "full");

/** Squares lit by the hottest plan, or by how today's tokens compare with the busiest day. */
export function UsageMeter({ summary, plans }: { summary: UsageSummary | null | undefined; plans: PlanSummary | null | undefined }) {
  const hot = hottestPlan(plans);
  const { today, peak } = usageToday(summary);
  if (!hot && !summary?.sources.length) return null;
  const share = hot ? (hot.percent ?? 0) / 100 : today / Math.max(peak, 1);
  const lit = share > 0 ? Math.max(1, Math.round(share * METER)) : 0;
  return (
    <span className={`usage-meter ${levelOf(hot?.percent ?? null)}`} aria-hidden>
      {Array.from({ length: METER }, (_, index) => (
        <i key={index} className={index < lit ? "on" : undefined} />
      ))}
    </span>
  );
}

// ------------------------------------------------------------------ plan limits

/** "11h 5m", "2d 4h" or "40m" in the reader's language. */
function span(ms: number, language: string): string {
  const unit = (value: number, name: "day" | "hour" | "minute") => new Intl.NumberFormat(language, { style: "unit", unit: name, unitDisplay: "narrow" }).format(value);
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 60) return unit(minutes, "minute");
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return minutes % 60 ? `${unit(hours, "hour")} ${unit(minutes % 60, "minute")}` : unit(hours, "hour");
  return hours % 24 ? `${unit(Math.floor(hours / 24), "day")} ${unit(hours % 24, "hour")}` : unit(hours / 24, "day");
}

function ago(iso: string, now: number, t: ReturnType<typeof useT>): string {
  const minutes = Math.round((now - Date.parse(iso)) / 60_000);
  if (minutes < 1) return t("plans.justNow");
  const format = new Intl.RelativeTimeFormat(t.language, { numeric: "auto", style: "short" });
  if (minutes < 60) return format.format(-minutes, "minute");
  if (minutes < 48 * 60) return format.format(-Math.round(minutes / 60), "hour");
  return format.format(-Math.round(minutes / 1440), "day");
}

export function PlanMark({ id, px = 2 }: { id: string; px?: number }) {
  const art = useMemo(() => planMark(id), [id]);
  if (!art) return null;
  return (
    <svg className="plan-mark" width={art.width * px} height={art.height * px} viewBox={`0 0 ${art.width} ${art.height}`} shapeRendering="crispEdges" aria-hidden>
      {art.cells.map((cell) => (
        <rect key={`${cell.x}.${cell.y}`} x={cell.x} y={cell.y} width={1} height={1} />
      ))}
    </svg>
  );
}

/**
 * The last day of a plan's percentage, one step per reading, on a 0–100 scale so a steady high
 * plan reads as full rather than as a mountain.
 */
function Sparkline({ points, percent }: { points: PlanPoint[]; percent: number }) {
  const values = [...points.map((point) => point.percent), percent];
  if (values.length < 2) values.unshift(percent);
  const y = (value: number) => 19 - (value / 100) * 18;
  const coords = values.map((value, index) => `${((index / (values.length - 1)) * 100).toFixed(2)},${y(value).toFixed(2)}`);
  return (
    <svg className="plan-spark" viewBox="0 0 100 20" preserveAspectRatio="none" aria-hidden>
      <polygon points={`0,20 ${coords.join(" ")} 100,20`} />
      <polyline points={coords.join(" ")} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

function PlanBlock({ provider, hot, now }: { provider: PlanProvider; hot: boolean; now: number }) {
  const t = useT();
  const name = PLAN_NAMES[provider.id];
  const level = levelOf(provider.percent);
  const when = (iso: string) => new Date(iso).toLocaleString(t.language, { weekday: "short", hour: "2-digit", minute: "2-digit" });
  let sub: string;
  if (provider.problem) {
    sub = t(`plans.problem.${provider.problem}`, { cli: name });
    if (provider.readAt) sub += ` · ${ago(provider.readAt, now, t)}`;
  } else if (provider.percent === null) {
    sub = t("plans.asking");
  } else {
    const parts = [];
    if (provider.resetsAt && Date.parse(provider.resetsAt) > now) parts.push(t("plans.resetsIn", { time: span(Date.parse(provider.resetsAt) - now, t.language) }));
    if (provider.fullAt) parts.push(t("plans.fullIn", { time: span(Date.parse(provider.fullAt) - now, t.language) }));
    sub = parts.join(" · ");
  }
  // One window that is the headline number already says everything.
  const rows = provider.windows.length === 1 && provider.windows[0].name === provider.limiter && provider.windows[0].percent === provider.percent ? [] : provider.windows;
  return (
    <div className={`plan ${level}${hot ? " hot" : ""}${provider.problem ? " stale" : ""}`}>
      <div className="plan-head">
        <PlanMark id={provider.id} />
        <b className="plan-pct">{provider.percent === null ? "—" : `${Math.round(provider.percent)}%`}</b>
        <span className="plan-name">
          <span className="plan-title">
            {name}
            {provider.limiter && rows.length > 0 ? <span className="faint"> · {provider.limiter}</span> : null}
          </span>
          <span className="plan-sub truncate">{sub}</span>
        </span>
        {hot && <span className="plan-tag">{t("plans.hot")}</span>}
      </div>
      {provider.percent !== null && (
        <>
          <div className="plan-bar">
            <i style={{ width: `${provider.percent}%` }} />
          </div>
          <Sparkline points={provider.history} percent={provider.percent} />
        </>
      )}
      {rows.map((window) => (
        <div
          key={window.name}
          className={`plan-window ${levelOf(window.percent)}`}
          {...(window.resetsAt ? tipProps(t("plans.windowResets", { time: when(window.resetsAt) }), { side: "left" }) : {})}
        >
          <span className="truncate">{window.name}</span>
          <span className="usage-track">
            <i style={{ width: `${window.percent}%` }} />
          </span>
          <span>{Math.round(window.percent)}%</span>
        </div>
      ))}
      {provider.credits !== null && provider.credits > 0 && (
        <div className="plan-credits faint">
          {t("plans.credits", { amount: new Intl.NumberFormat(t.language, { style: "currency", currency: "USD" }).format(provider.credits) })}
        </div>
      )}
    </div>
  );
}

export function PlanPanel({ plans, switcher, networkOn, onRefresh }: { plans: PlanSummary; switcher?: ReactNode; networkOn: boolean; onRefresh: () => Promise<void> }) {
  const t = useT();
  const now = useNow(30_000);
  const [busy, setBusy] = useState(false);
  const hot = hottestPlan(plans);
  const several = plans.providers.filter((provider) => provider.percent !== null).length > 1;
  return (
    <div className="usage-panel">
      <div className="list-label usage-title">
        <span className="grow">{t("plans.title")}</span>
        {switcher}
      </div>
      {plans.providers.length === 0 && <div className="faint usage-note">{t("plans.none")}</div>}
      {plans.providers.map((provider) => (
        <PlanBlock key={provider.id} provider={provider} hot={several && provider.id === hot?.id} now={now} />
      ))}
      <div className="usage-note plan-foot">
        <span className="faint grow">{networkOn ? t("plans.updated", { when: ago(plans.checkedAt, now, t) }) : t("plans.offNote")}</span>
        {networkOn && (
          <Button
            size="sm"
            variant="ghost"
            icon={RefreshCw}
            busy={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await onRefresh();
              } finally {
                setBusy(false);
              }
            }}
          >
            {t("plans.refresh")}
          </Button>
        )}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ tokens

export const USAGE_PERIODS: UsagePeriod[] = ["today", "week", "month", "all"];

/** Bars this many columns or more are drawn as thin columns, a pixel apart. */
const DENSE = 11;

function shortDate(day: string, language: string): string {
  const [year, month, date] = day.split("-").map(Number);
  const when = new Date(year, month - 1, date);
  return when.toLocaleDateString(language, { month: "short", day: "numeric", ...(year === new Date().getFullYear() ? {} : { year: "numeric" }) });
}

function SourceRow({ source, label, period }: { source: UsageSource; label: string; period: UsagePeriod }) {
  const t = useT();
  const span = source.periods[period];
  const total = span.tokens.total;
  const cached = total ? Math.round((span.tokens.cached / total) * 100) : 0;
  // A quiet day still says which model the week was spent on.
  const model = (span.models[0] ?? source.periods.week.models[0])?.model;
  const bars =
    period === "all"
      ? t("usage.bars.all", { total: compactTokens(total, t.language), date: source.since ? shortDate(source.since, t.language) : "" })
      : period === "month"
        ? t("usage.bars.month", { total: compactTokens(total, t.language) })
        : t("usage.week", { total: compactTokens(source.periods.week.tokens.total, t.language) });
  const dense = span.bars.length >= DENSE;
  return (
    <div className="usage-source">
      <div className="usage-head">
        <span className="truncate" style={{ color: "var(--fg)" }}>
          {label}
        </span>
        <span className="grow" />
        <b>{compactTokens(total, t.language)}</b>
      </div>
      <div className="usage-sub">
        <span className="truncate">
          {total ? t("usage.cached", { percent: cached }) : t("usage.quietToday")}
          {model ? ` · ${model}` : ""}
        </span>
        <span className="grow" />
        <BlockBars values={span.bars} rows={4} label={bars} cell={dense ? 2 : undefined} className={dense ? "dense" : undefined} />
      </div>
    </div>
  );
}

export function UsagePanel({
  summary,
  switcher,
  period,
  onPeriod,
}: {
  summary: UsageSummary;
  switcher?: ReactNode;
  period: UsagePeriod;
  onPeriod: (period: UsagePeriod) => void;
}) {
  const t = useT();
  const engines = useEngines().data ?? [];
  const label = (id: string) => engines.find((engine) => engine.id === id)?.label ?? (id in PLAN_NAMES ? PLAN_NAMES[id as keyof typeof PLAN_NAMES] : id);
  // Today lists every CLI used this week, so a quiet one still shows its 0.
  const shownBy = period === "today" ? "week" : period;
  const sources = summary.sources.filter((source) => source.periods[shownBy].tokens.total > 0);
  const together = sources.reduce((sum, source) => sum + source.periods[period].tokens.total, 0);
  const since = summary.sources
    .map((source) => source.since)
    .filter((day): day is string => day !== null)
    .sort()[0];
  return (
    <div className="usage-panel">
      <div className="list-label usage-title">
        <span className="grow">{period === "today" ? t("usage.title") : t(`usage.title.${period}`)}</span>
        {switcher}
      </div>
      <div className="usage-periods" role="group" aria-label={t("usage.periods")}>
        {USAGE_PERIODS.map((value) => (
          <button key={value} type="button" aria-pressed={period === value} onClick={() => onPeriod(value)}>
            {t(`usage.period.${value}`)}
          </button>
        ))}
      </div>
      {sources.length === 0 && <div className="faint usage-note">{period === "month" || period === "all" ? t(`usage.none.${period}`) : t("usage.none")}</div>}
      {[...sources]
        .sort((a, b) => b.periods[period].tokens.total - a.periods[period].tokens.total || b.periods.week.tokens.total - a.periods.week.tokens.total)
        .map((source) => (
          <SourceRow key={source.id} source={source} label={label(source.id)} period={period} />
        ))}
      {sources.length > 1 && (
        <div className="usage-source usage-together">
          <div className="usage-head">
            <span className="truncate">{t("usage.together")}</span>
            <span className="grow" />
            <b>{compactTokens(together, t.language)}</b>
          </div>
        </div>
      )}
      <div className="faint usage-note">{period === "all" && since ? t("usage.since", { date: shortDate(since, t.language) }) : t("usage.note")}</div>
    </div>
  );
}
