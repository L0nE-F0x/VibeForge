import os from "node:os";
import path from "node:path";

/** Reading fields from a file people edit by hand: anything of the wrong type is the fallback. */

export function str(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

export function strOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

export function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

export function strList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.length > 0);
}

/**
 * A folder as written by hand. The window shows folders from home (`~/Projects/shop`), so one
 * written that way is read from this machine's home, not as a folder named "~" that never exists.
 */
export function fromHome(folder: string): string {
  return folder === "~" ? os.homedir() : folder.startsWith("~/") ? path.join(os.homedir(), folder.slice(2)) : folder;
}
