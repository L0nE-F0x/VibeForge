import path from "node:path";

// path.relative treats "/tmp/proj-other" as outside "/tmp/proj"; a string prefix would not.
export function isPathInside(parent: string, child: string): boolean {
  const base = path.resolve(parent);
  const target = path.resolve(child);
  if (base === target) return true;
  const relative = path.relative(base, target);
  if (relative === "") return true;
  if (relative.startsWith("..") || path.isAbsolute(relative)) return false;
  return true;
}

export function cwdAllowed(cwd: string, places: readonly string[]): boolean {
  if (typeof cwd !== "string" || cwd.length === 0) return false;
  return places.some((place) => typeof place === "string" && place.length > 0 && isPathInside(place, cwd));
}
