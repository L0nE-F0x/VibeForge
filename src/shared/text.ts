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

export function timeAgo(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "";
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  const seconds = Math.round((now - then) / 1000);
  const future = seconds < 0;
  const s = Math.abs(seconds);
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
