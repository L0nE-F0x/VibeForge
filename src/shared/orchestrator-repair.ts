// Tolerant JSON extraction, structural repair, field aliasing, and early-say extraction
// for Viby's planner output. Pure and Node-free so shared/UI/core can reuse it cleanly.

/** Remove markdown code fences while keeping their inner payload. */
export function stripCodeFences(raw: string): string {
  return raw.replace(/```(?:json|jsonc|js|ts)?\s*\r?\n?([\s\S]*?)```/gi, "$1").trim();
}

/**
 * Repair common LLM JSON formatting mistakes inside an isolated JSON candidate object:
 * - unescaped literal control chars (`\n`, `\r`, `\t`) inside double-quoted strings
 * - trailing commas before `}` or `]`
 */
export function repairJsonText(raw: string): string {
  let out = "";
  let inString = false;
  let escaped = false;
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    if (inString) {
      if (escaped) {
        out += ch;
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        out += ch;
        escaped = true;
        continue;
      }
      if (ch === '"') {
        inString = false;
        out += ch;
        continue;
      }
      if (ch === "\n") {
        out += "\\n";
        continue;
      }
      if (ch === "\r") {
        out += "\\r";
        continue;
      }
      if (ch === "\t") {
        out += "\\t";
        continue;
      }
      out += ch;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    // Drop trailing commas before `}` or `]`
    if (ch === ",") {
      let k = i + 1;
      while (k < raw.length && /\s/.test(raw[k])) k += 1;
      if (raw[k] === "}" || raw[k] === "]") continue;
    }
    out += ch;
  }
  return out;
}

/** Attempt to close unclosed brackets/braces on truncated JSON output cleanly. */
function tryCloseTruncatedJson(raw: string): unknown | null {
  const cleaned = repairJsonText(raw).replace(/,\s*$/, "");
  const stack: Array<"}" | "]"> = [];
  let inString = false;
  let escaped = false;
  for (let i = 0; i < cleaned.length; i += 1) {
    const ch = cleaned[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") stack.push("}");
    else if (ch === "[") stack.push("]");
    else if ((ch === "}" || ch === "]") && stack.at(-1) === ch) stack.pop();
  }
  if (inString || !stack.length || stack.length > 4) return null;
  const suffix = [...stack].reverse().join("");
  try {
    return JSON.parse(cleaned + suffix);
  } catch {
    return null;
  }
}

/**
 * Extract balanced or repaired top-level JSON objects from noisy prose or fenced blocks.
 */
export function repairJsonObjects(text: string): unknown[] {
  const source = stripCodeFences(text);
  const found: unknown[] = [];
  for (let i = 0; i < source.length; i += 1) {
    if (source[i] !== "{") continue;
    let depth = 0;
    let inString = false;
    let escaped = false;
    let closedAt = -1;
    for (let j = i; j < source.length; j += 1) {
      const ch = source[j];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === "{") depth += 1;
      else if (ch === "}") {
        depth -= 1;
        if (depth === 0) {
          closedAt = j;
          break;
        }
      }
    }
    if (closedAt < 0) {
      const truncated = tryCloseTruncatedJson(source.slice(i));
      if (truncated && typeof truncated === "object" && !Array.isArray(truncated)) {
        found.push(truncated);
        break;
      }
      continue;
    }
    const slice = source.slice(i, closedAt + 1);
    for (const attempt of [slice, repairJsonText(slice)]) {
      try {
        found.push(JSON.parse(attempt));
        i = closedAt;
        break;
      } catch {
        /* try repaired form or continue */
      }
    }
  }
  return found;
}

function asStringBool(value: unknown): unknown {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const low = value.trim().toLowerCase();
    if (low === "true") return true;
    if (low === "false") return false;
  }
  return value;
}

function asStringList(value: unknown): unknown {
  if (Array.isArray(value)) return value;
  if (typeof value === "string") {
    const items = value
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    return items.length ? items : undefined;
  }
  return value;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return Boolean(v && typeof v === "object" && !Array.isArray(v));
}

/**
 * Unwrap nested plan envelopes and normalize unambiguous top-level and step field aliases.
 * Unknown step `kind` values are left intact so unknown-step handling still surfaces them.
 */
export function normalizePlanCandidate(value: unknown, validKinds: readonly string[]): unknown {
  if (!isRecord(value)) return value;
  if (value.status === "ERROR" || value.is_error === true) return value;

  let record: Record<string, unknown> = value;
  for (const wrapper of ["plan", "output", "data", "result"] as const) {
    const inner = record[wrapper];
    if (
      isRecord(inner) &&
      record.say === undefined &&
      record.steps === undefined &&
      (inner.say !== undefined || inner.steps !== undefined || inner.actions !== undefined || inner.message !== undefined || inner.reply !== undefined)
    ) {
      record = inner;
      break;
    }
  }

  const validSet = new Set(validKinds);
  const rawSteps = record.steps !== undefined ? record.steps : Array.isArray(record.actions) ? record.actions : undefined;
  const rawSay =
    record.say !== undefined
      ? record.say
      : typeof record.message === "string"
        ? record.message
        : typeof record.reply === "string"
          ? record.reply
          : typeof record.speech === "string"
            ? record.speech
            : undefined;

  if (!Array.isArray(rawSteps)) {
    return rawSay === record.say ? record : { ...record, ...(rawSay !== undefined ? { say: rawSay } : {}) };
  }

  const normalizedSteps = rawSteps.map((item) => {
    if (!isRecord(item)) return item;
    const rawKind =
      typeof item.kind === "string"
        ? item.kind
        : typeof item.type === "string"
          ? item.type
          : typeof item.step === "string"
            ? item.step
            : "";
    const trimmedKind = rawKind.trim();
    const loweredKind = trimmedKind.toLowerCase();
    const kind = validSet.has(loweredKind) ? loweredKind : trimmedKind;

    const engine = item.engine ?? (typeof item.cli === "string" ? item.cli : typeof item.engineId === "string" ? item.engineId : undefined);
    const workspace = item.workspace ?? (typeof item.workspaceId === "string" ? item.workspaceId : typeof item.project === "string" ? item.project : undefined);
    const folder = item.folder ?? (typeof item.path === "string" ? item.path : typeof item.dir === "string" ? item.dir : undefined);

    return {
      ...item,
      kind,
      ...(engine !== undefined ? { engine } : {}),
      ...(workspace !== undefined ? { workspace } : {}),
      ...(folder !== undefined ? { folder } : {}),
      ...(item.git !== undefined ? { git: asStringBool(item.git) } : {}),
      ...(item.inPlace !== undefined ? { inPlace: asStringBool(item.inPlace) } : {}),
      ...(item.after !== undefined ? { after: asStringBool(item.after) } : {}),
      ...(item.places !== undefined ? { places: asStringList(item.places) } : {}),
      ...(item.skills !== undefined ? { skills: asStringList(item.skills) } : {}),
      ...(item.agents !== undefined ? { agents: asStringList(item.agents) } : {}),
    };
  });

  return {
    ...record,
    ...(rawSay !== undefined ? { say: rawSay } : {}),
    steps: normalizedSteps,
    ...(record.hangup !== undefined ? { hangup: asStringBool(record.hangup) } : {}),
    ...(record.confirmWaiting !== undefined ? { confirmWaiting: asStringBool(record.confirmWaiting) } : {}),
  };
}

/**
 * Incrementally extract the completed top-level `"say"` field from partial JSON or Claude `stream-json`
 * output so live voice calls can pre-warm or start synthesis before the CLI process exits.
 */
export function extractEarlySay(buffer: string): string | null {
  // Handle Claude `--output-format stream-json --include-partial-messages` delta events if present.
  let text = buffer;
  if (buffer.includes('"stream_event"') || buffer.includes('"content_block_delta"') || buffer.includes('"assistant"')) {
    const pieces: string[] = [];
    for (const line of buffer.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("{")) continue;
      try {
        const ev = JSON.parse(trimmed) as Record<string, unknown>;
        if (ev.type === "stream_event" && isRecord(ev.event)) {
          const delta = ev.event.delta;
          if (isRecord(delta)) {
            if (typeof delta.partial_json === "string") pieces.push(delta.partial_json);
            else if (typeof delta.text === "string") pieces.push(delta.text);
          }
        } else if (ev.type === "result" && isRecord(ev.structured_output) && typeof ev.structured_output.say === "string") {
          return ev.structured_output.say.trim() || null;
        }
      } catch {
        /* ignore partial line */
      }
    }
    if (pieces.length) text = pieces.join("");
  }

  const keyMatch = /"say"\s*:\s*"/.exec(text);
  if (!keyMatch) return null;
  const start = keyMatch.index + keyMatch[0].length;
  let end = -1;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      end = i;
      break;
    }
  }
  if (end < 0) return null;
  try {
    const decoded = JSON.parse(`"${text.slice(start, end)}"`) as string;
    return decoded.trim() || null;
  } catch {
    return null;
  }
}
