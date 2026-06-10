export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

export function slugify(s: string): string {
  return (s || "app").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "app";
}

/** Extract the first balanced JSON array/object from a model reply (tolerates prose + ``` fences). */
export function extJson<T = unknown>(text: string, open: "[" | "{" = "["): T {
  const close = open === "[" ? "]" : "}";
  const i = text.indexOf(open);
  if (i < 0) throw new Error("no JSON found in the reply");
  let depth = 0, inStr = false, esc = false;
  for (let j = i; j < text.length; j++) {
    const c = text[j];
    if (inStr) { if (esc) esc = false; else if (c === "\\") esc = true; else if (c === '"') inStr = false; }
    else if (c === '"') inStr = true;
    else if (c === open) depth++;
    else if (c === close) { depth--; if (depth === 0) return JSON.parse(text.slice(i, j + 1)) as T; }
  }
  throw new Error("unbalanced JSON in the reply");
}

export function hostOf(u: string): string {
  try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return u; }
}
