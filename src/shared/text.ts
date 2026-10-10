/** Quote a path for a POSIX shell; plain paths stay readable. */
export function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function initials(name: string): string {
  const words = name.trim().split(/[\s_-]+/).filter(Boolean);
  if (words.length === 0) return "?";
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return `${words[0][0]}${words[1][0]}`.toUpperCase();
}

export function plural(count: number, word: string, many = `${word}s`): string {
  return `${count} ${count === 1 ? word : many}`;
}

/**
 * "5 min ago", "yesterday", "in 3 hr". English keeps its own short wording; other languages use
 * `Intl.RelativeTimeFormat`, with the same steps.
 */
export function timeAgo(iso: string | null | undefined, now = Date.now(), language = "en"): string {
  if (!iso) return "";
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  const seconds = Math.round((now - then) / 1000);
  const future = seconds < 0;
  const s = Math.abs(seconds);
  // A clock that ticks every few seconds (TimeAgo) sees something that just happened as slightly
  // ahead of it; that is "just now", not "in a moment".
  if (future && s <= 60) return language.startsWith("en") ? "just now" : new Intl.RelativeTimeFormat(language, { numeric: "auto", style: "short" }).format(0, "second");
  if (!language.startsWith("en")) {
    const format = new Intl.RelativeTimeFormat(language, { numeric: "auto", style: "short" });
    const sign = future ? 1 : -1;
    if (s < 45) return format.format(0, "second");
    if (s < 3600) return format.format(sign * Math.max(1, Math.round(s / 60)), "minute");
    if (s < 86400) return format.format(sign * Math.max(1, Math.round(s / 3600)), "hour");
    return format.format(sign * Math.max(1, Math.round(s / 86400)), "day");
  }
  let text: string;
  if (s < 45) text = future ? "in a moment" : "just now";
  else if (s < 90) text = "1 min";
  else if (s < 3600) text = `${Math.round(s / 60)} min`;
  else if (s < 5400) text = "1 hr";
  else if (s < 86400) text = `${Math.round(s / 3600)} hr`;
  else if (s < 172800) text = future ? "tomorrow" : "yesterday";
  else text = `${Math.round(s / 86400)} days`;
  if (text === "just now" || text === "in a moment" || text === "yesterday" || text === "tomorrow") return text;
  return future ? `in ${text}` : `${text} ago`;
}

/** "now", "16m", "3h", "2d": how long ago, as short as the language writes it, for a narrow list. */
export function shortAgo(iso: string | null | undefined, now = Date.now(), language = "en"): string {
  if (!iso) return "";
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  const s = Math.max(0, Math.round((now - then) / 1000));
  if (s < 60) return new Intl.RelativeTimeFormat(language, { numeric: "auto" }).format(0, "second");
  const [value, unit] = s < 3600 ? [s / 60, "minute"] : s < 86400 ? [s / 3600, "hour"] : s < 86400 * 7 ? [s / 86400, "day"] : [s / (86400 * 7), "week"];
  return new Intl.NumberFormat(language, { style: "unit", unit, unitDisplay: "narrow" }).format(Math.floor(value));
}

export function duration(startIso: string, endIso: string | null, now = Date.now()): string {
  const start = Date.parse(startIso);
  const end = endIso ? Date.parse(endIso) : now;
  if (Number.isNaN(start) || Number.isNaN(end)) return "";
  const s = Math.max(0, Math.round((end - start) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}m`;
}

export function clockTime(iso: string | null | undefined): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const today = new Date();
  const sameDay = date.toDateString() === today.toDateString();
  const time = date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
  if (sameDay) return time;
  const tomorrow = new Date(today);
  tomorrow.setDate(today.getDate() + 1);
  if (date.toDateString() === tomorrow.toDateString()) return `Tomorrow ${time}`;
  return `${date.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" })} ${time}`;
}

export function tildify(target: string, home: string): string {
  if (!home) return target;
  if (target === home) return "~";
  return target.startsWith(`${home}/`) ? `~${target.slice(home.length)}` : target;
}

/** Split `--flag "two words" {prompt}` the way a shell would, minus expansion. */
export function splitArgs(text: string): string[] {
  const out: string[] = [];
  let current = "";
  let quote: string | null = null;
  let has = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === "\\" && quote !== "'" && index + 1 < text.length) {
      index += 1;
      current += text[index];
      has = true;
    } else if (quote) {
      if (char === quote) quote = null;
      else current += char;
    } else if (char === '"' || char === "'") {
      quote = char;
      has = true;
    } else if (/\s/.test(char)) {
      if (has) out.push(current);
      current = "";
      has = false;
    } else {
      current += char;
      has = true;
    }
  }
  if (has) out.push(current);
  return out;
}

export function joinArgs(args: string[] | undefined): string {
  return (args ?? []).map((arg) => (/[\s"'\\]/.test(arg) || arg === "" ? `"${arg.replace(/[\\"]/g, (match) => `\\${match}`)}"` : arg)).join(" ");
}

/** The local calendar day of an ISO time, as `YYYY-MM-DD`, for grouping a list by day. */
export function dayKey(iso: string): string {
  const date = new Date(iso);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

/**
 * A heading for a day in a list: "Today", "Yesterday", the weekday within the last week, then
 * a date (with the year once it isn't this year). Worded by `Intl` in the given language.
 */
export function dayHeading(iso: string, language: string, now = Date.now()): string {
  const date = new Date(iso);
  const start = (value: Date | number) => {
    const copy = new Date(value);
    copy.setHours(0, 0, 0, 0);
    return copy.getTime();
  };
  const back = Math.round((start(now) - start(date)) / 86_400_000);
  const upper = (text: string) => text.charAt(0).toLocaleUpperCase(language) + text.slice(1);
  if (back >= 0 && back < 2) return upper(new Intl.RelativeTimeFormat(language, { numeric: "auto" }).format(-back, "day"));
  if (back > 0 && back < 7) return upper(date.toLocaleDateString(language, { weekday: "long" }));
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  return date.toLocaleDateString(language, { day: "numeric", month: "short", ...(sameYear ? {} : { year: "numeric" }) });
}

/** Around the matched words in a search snippet: control characters no indexed transcript keeps. */
export const SNIPPET_OPEN = "\u0002";
export const SNIPPET_CLOSE = "\u0003";

/** A search snippet as plain runs and matched runs, for highlighting. */
export function snippetParts(snippet: string): Array<{ text: string; hit: boolean }> {
  const parts: Array<{ text: string; hit: boolean }> = [];
  for (const piece of snippet.split(SNIPPET_OPEN)) {
    const close = piece.indexOf(SNIPPET_CLOSE);
    if (close < 0) {
      if (piece) parts.push({ text: piece, hit: false });
      continue;
    }
    if (close > 0) parts.push({ text: piece.slice(0, close), hit: true });
    const rest = piece.slice(close + 1);
    if (rest) parts.push({ text: rest, hit: false });
  }
  return parts.map((part) => ({ ...part, text: part.text.replace(/\s+/g, " ") }));
}

/** "a, b and c" in the reader's language. */
export function listText(items: readonly string[], language: string): string {
  try {
    return new Intl.ListFormat(language, { type: "conjunction" }).format(items);
  } catch {
    return items.join(", ");
  }
}

