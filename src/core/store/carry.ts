// A newer VibeForge may have written fields into settings.json or an agent.yaml that this one
// doesn't know. Reading drops them (each file is rebuilt from the fields known here), so saving
// would too: after going back a version, changing one setting erased everything the newer one
// added. Saving carries them over from the file on disk instead.

/** The fields this version knows, nested where a field is an object of its own; `true` for any other value. */
export interface Shape {
  [field: string]: Shape | true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** The shape of `value`: every field, each object in it followed into. Lists count as one value. */
export function shapeOf(value: Record<string, unknown>): Shape {
  const shape: Shape = {};
  for (const [field, inner] of Object.entries(value)) shape[field] = isRecord(inner) ? shapeOf(inner) : true;
  return shape;
}

/**
 * `known` with every field of `raw` that `shape` doesn't name added after its own, in every
 * object `shape` names too. A field `shape` names is never taken from `raw`: what is known is
 * written as this version means it, and one left out of `known` (cleared) stays out.
 */
export function carryUnknown<T extends Record<string, unknown>>(known: T, raw: unknown, shape: Shape): T {
  if (!isRecord(raw)) return known;
  const out: Record<string, unknown> = { ...known };
  for (const [field, value] of Object.entries(raw)) {
    const inner = shape[field];
    if (inner === undefined) {
      if (!(field in out)) out[field] = value;
    } else if (inner !== true && isRecord(out[field])) {
      out[field] = carryUnknown(out[field] as Record<string, unknown>, value, inner);
    }
  }
  return out as T;
}

/**
 * The format number to write: this version's, or the file's own when a newer VibeForge wrote it,
 * so that version still knows its fields are there.
 */
export function formatVersion(raw: unknown, current: number): number {
  const saved = isRecord(raw) ? raw.version : undefined;
  return typeof saved === "number" && Number.isInteger(saved) && saved > current ? saved : current;
}
