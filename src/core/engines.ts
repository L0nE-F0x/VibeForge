import { execFileSync } from "node:child_process";
import type { EngineRow } from "./types.js";

export function whichBin(bin: string): string | null {
  if (typeof bin !== "string" || bin.length === 0 || bin.includes("\0")) return null;
  try {
    const stdout = execFileSync("which", [bin], {
      encoding: "utf8",
      timeout: 2000,
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });
    const found = stdout
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.length > 0);
    return found ?? null;
  } catch {
    return null;
  }
}

export function withAvailability<T extends Pick<EngineRow, "bin">>(
  engines: readonly T[],
  resolveBin: (bin: string) => string | null,
): Array<T & { available: boolean }> {
  return engines.map((engine) => {
    const resolved = resolveBin(engine.bin);
    const available = typeof resolved === "string" && resolved.length > 0;
    return { ...engine, available };
  });
}
