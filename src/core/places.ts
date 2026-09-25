import path from "node:path";

// path.relative treats "/tmp/proj-other" as outside "/tmp/proj"; a string prefix would not.
export function isPathInside(parent: string, child: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  if (relative === "") return true;
  if (path.isAbsolute(relative)) return false;
  return relative !== ".." && !relative.startsWith(`..${path.sep}`);
}

export function cwdAllowed(cwd: string, places: readonly string[]): boolean {
  if (typeof cwd !== "string" || cwd.length === 0) return false;
  return places.some((place) => typeof place === "string" && place.length > 0 && isPathInside(place, cwd));
}
