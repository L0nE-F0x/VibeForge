import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { readText, writeFileAtomic } from "./fsx.js";
import { RUN_FILES, type RunFiles } from "./runs.js";

interface RestoredScreen {
  ansi: string;
  transcript: string;
}

interface CaptureModule {
  plainText(text: string): string;
  restoreScrollback(scrollback: string): Promise<RestoredScreen | null>;
}

function captureModule(): CaptureModule | null {
  const require = createRequire(import.meta.url);
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(here, "../../electron/terminal-capture.cjs"),
    path.resolve(here, "../electron/terminal-capture.cjs"),
  ];
  for (const file of candidates) {
    if (fs.existsSync(file)) return require(file) as CaptureModule;
  }
  return null;
}

/**
 * A finished run whose saved screen is blank still has the session in scrollback.txt.
 * Rebuild the frame from the bytes before the program left the alternate screen, and
 * store it so the next open doesn't parse the scrollback again.
 */
export async function repairBlankCapture(dir: string, files: RunFiles): Promise<RunFiles> {
  const capture = captureModule();
  if (!capture) return files;
  if (capture.plainText(files.transcript) || capture.plainText(files.screen)) return files;
  const scrollback = readText(path.join(dir, RUN_FILES.scrollback));
  if (scrollback.length < 32) return files;
  const restored = await capture.restoreScrollback(scrollback);
  if (!restored || !capture.plainText(restored.transcript)) return files;
  try {
    writeFileAtomic(path.join(dir, RUN_FILES.screen), restored.ansi);
    writeFileAtomic(path.join(dir, RUN_FILES.transcript), restored.transcript);
  } catch {
    /* the folder can be read-only; this view still gets the text */
  }
  return { ...files, screen: restored.ansi, scrollback: "", transcript: restored.transcript };
}
