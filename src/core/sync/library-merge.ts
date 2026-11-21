import { createHash } from "node:crypto";

// How two machines' versions of one part of an agent or a skill become one, with nothing but the
// two versions and the last one both had (the base). Every function here gives the same answer on
// either machine for the same inputs, so two machines that merge at the same moment end up equal.

/** Each machine's count of its own changes to one part: the start of its id → count. */
export type Clock = Record<string, number>;

export type Order = "same" | "before" | "after" | "apart";

/** How `a` stands to `b`: the same, older, newer, or changed on both since they last agreed. */
export function compareClocks(a: Clock, b: Clock): Order {
  let less = false;
  let more = false;
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const left = a[key] ?? 0;
    const right = b[key] ?? 0;
    if (left < right) less = true;
    if (left > right) more = true;
  }
  if (less && more) return "apart";
  if (less) return "before";
  if (more) return "after";
  return "same";
}

export function joinClocks(a: Clock, b: Clock): Clock {
  const out: Clock = { ...a };
  for (const [key, count] of Object.entries(b)) out[key] = Math.max(out[key] ?? 0, count);
  return out;
}

export function tick(clock: Clock, me: string): Clock {
  return { ...clock, [me]: (clock[me] ?? 0) + 1 };
}

/** A short fingerprint of any value, for "has it changed?". */
export function hashValue(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value ?? null)).digest("hex").slice(0, 24);
}

/** Who made a change and when: the later one wins a tie that can't be merged; the machine id breaks an exact tie. */
export interface Stamp {
  at: string;
  by: string;
}

/** True when `a` is the later change. */
export function later(a: Stamp, b: Stamp): boolean {
  if (a.at !== b.at) return a.at > b.at;
  return a.by > b.by;
}

// ------------------------------------------------------------------ text, line by line

/** For each line of `base`, the index of the same line in `other` (or -1), along one longest common run. */
export function matchLines(base: readonly string[], other: readonly string[], maxCells = 4_000_000): number[] {
  const map = new Array<number>(base.length).fill(-1);
  let start = 0;
  while (start < base.length && start < other.length && base[start] === other[start]) {
    map[start] = start;
    start += 1;
  }
  let endBase = base.length;
  let endOther = other.length;
  while (endBase > start && endOther > start && base[endBase - 1] === other[endOther - 1]) {
    endBase -= 1;
    endOther -= 1;
    map[endBase] = endOther;
  }
  const n = endBase - start;
  const m = endOther - start;
  // Too big a middle to compare line by line: treat it as all changed, which only costs a conflict.
  if (n === 0 || m === 0 || n * m > maxCells) return map;
  const width = m + 1;
  const table = new Uint32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      table[i * width + j] = base[start + i] === other[start + j] ? table[(i + 1) * width + j + 1] + 1 : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
    }
  }
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (base[start + i] === other[start + j]) {
      map[start + i] = start + j;
      i += 1;
      j += 1;
    } else if (table[(i + 1) * width + j] >= table[i * width + j + 1]) i += 1;
    else j += 1;
  }
  return map;
}

export type Chunk = { ok: string[] } | { conflict: { base: string[]; ours: string[]; theirs: string[] } };

const same = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((line, index) => line === b[index]);

/** The classic three-way merge: runs both sides kept from the base, and between them what changed. */
export function diff3(base: readonly string[], ours: readonly string[], theirs: readonly string[]): Chunk[] {
  const toOurs = matchLines(base, ours);
  const toTheirs = matchLines(base, theirs);
  const chunks: Chunk[] = [];
  const push = (lines: string[]) => {
    if (!lines.length) return;
    const last = chunks.at(-1);
    if (last && "ok" in last) last.ok.push(...lines);
    else chunks.push({ ok: [...lines] });
  };
  const settle = (b: string[], o: string[], t: string[]) => {
    if (!b.length && !o.length && !t.length) return;
    if (same(o, b)) push(t);
    else if (same(t, b)) push(o);
    else if (same(o, t)) push(o);
    else chunks.push({ conflict: { base: b, ours: o, theirs: t } });
  };
  let ib = 0;
  let io = 0;
  let it = 0;
  for (;;) {
    let j = ib;
    // A base line kept on both sides, and not behind where either side has got to.
    while (j < base.length && !(toOurs[j] >= io && toTheirs[j] >= it)) j += 1;
    if (j === base.length) {
      settle(base.slice(ib), ours.slice(io), theirs.slice(it));
      break;
    }
    settle(base.slice(ib, j), ours.slice(io, toOurs[j]), theirs.slice(it, toTheirs[j]));
    push([base[j]]);
    ib = j + 1;
    io = toOurs[j] + 1;
    it = toTheirs[j] + 1;
  }
  return chunks;
}

const lines = (text: string): string[] => (text === "" ? [] : text.split("\n"));

export interface TextMerge {
  text: string;
  /** Both sides changed the same lines of the base. */
  clashed: boolean;
  /** Lines of ours that are not in the result: what this machine would lose. */
  oursLost: boolean;
  /** The same for theirs. */
  theirsLost: boolean;
}

/**
 * Merges two versions of a text against the last one both had. Where both only added lines at
 * the same place, both additions are kept (the earlier change's first). Where both changed the
 * same lines: "union" keeps both versions' lines (memory: nothing is lost), "later" keeps the later
 * change's and reports the other as lost (a brief, a skill).
 */
export function mergeText(base: string, ours: { text: string } & Stamp, theirs: { text: string } & Stamp, overlap: "union" | "later"): TextMerge {
  const oursFirst = !later(ours, theirs);
  const out: string[] = [];
  let clashed = false;
  let oursLost = false;
  let theirsLost = false;
  for (const chunk of diff3(lines(base), lines(ours.text), lines(theirs.text))) {
    if ("ok" in chunk) {
      out.push(...chunk.ok);
      continue;
    }
    const { base: was, ours: mine, theirs: other } = chunk.conflict;
    const [first, second] = oursFirst ? [mine, other] : [other, mine];
    if (!was.length || overlap === "union") {
      if (was.length) clashed = true;
      out.push(...first, ...second.filter((line) => line.trim() === "" || !first.includes(line)));
      continue;
    }
    clashed = true;
    if (later(ours, theirs)) {
      out.push(...mine);
      theirsLost = true;
    } else {
      out.push(...other);
      oursLost = true;
    }
  }
  return { text: out.join("\n"), clashed, oursLost, theirsLost };
}

// ------------------------------------------------------------------ sets

/**
 * Merges two versions of a set against the last one both had: anything either side added stays,
 * anything one side removed goes unless the other side added it again. Items are matched by `key`;
 * where both have one, the later change's is kept. The order is the later side's, then the rest.
 */
export function mergeSet<T>(base: readonly T[], ours: { items: readonly T[] } & Stamp, theirs: { items: readonly T[] } & Stamp, key: (item: T) => string): T[] {
  const inBase = new Set(base.map(key));
  const mine = new Map(ours.items.map((item) => [key(item), item]));
  const other = new Map(theirs.items.map((item) => [key(item), item]));
  const keep = (id: string) => (mine.has(id) && other.has(id)) || (mine.has(id) && !inBase.has(id)) || (other.has(id) && !inBase.has(id));
  const [first, second] = later(ours, theirs) ? [ours.items, theirs.items] : [theirs.items, ours.items];
  const winner = later(ours, theirs) ? mine : other;
  const out: T[] = [];
  const seen = new Set<string>();
  for (const item of [...first, ...second]) {
    const id = key(item);
    if (seen.has(id) || !keep(id)) continue;
    seen.add(id);
    out.push(winner.get(id) ?? item);
  }
  return out;
}
