import os from "node:os";
import path from "node:path";
import { app } from "electron";
import { controlSocketPath } from "../src/core/control.js";
import { whichBin } from "../src/core/engines.js";
import type { CompanionWire } from "./companion.js";
import type { MainContext } from "./main-context.js";
import type { Stats } from "./stats.js";
import { Voice } from "./voice.js";

// Voice (dictation, spoken answers, the keybindings) and the phone page, wired to the rest of the
// main process.

export function makeVoice(ctx: MainContext): Voice {
  const { log, roots, send } = ctx;
  return new Voice({
    log,
    home: os.homedir(),
    dataRoot: roots.dataRoot,
    settings: () => ctx.svc().getSettings().voice,
    resolveBin: (bin) => whichBin(bin),
    state: (state) => send("voice", state),
    changed: () => send("changed", ["voice"]),
    speaking: () => send("changed", ["voice"]),
    // Settings' language, or the desktop's: a voice in it is preferred.
    language: () => {
      const chosen = ctx.service?.getSettings().language ?? "system";
      return (chosen === "system" ? app.getLocale() : chosen).slice(0, 2).toLowerCase();
    },
    controlSocket: controlSocketPath(roots.dataRoot, process.env.XDG_RUNTIME_DIR, process.getuid?.() ?? 0),
    // The installed launcher when it is on PATH (it is a link to scripts/vibeforge), else the script itself.
    launcher: () => (whichBin("vibeforge") ? "vibeforge" : path.join(ctx.appRoot, "scripts", "vibeforge")),
  });
}

/** What the phone page's server is handed; made again whenever Settings change. */
export function companionWire(ctx: MainContext, stats: Pick<Stats, "planSummary">, voice: Pick<Voice, "transcribe" | "canTranscribe">): CompanionWire {
  return {
    service: ctx.svc(),
    supervisor: ctx.supervisor,
    root: path.join(ctx.appRoot, "companion"),
    icon: ctx.iconPath,
    log: (line: string) => ctx.log.info(line),
    plans: () => stats.planSummary(false),
    hear: (pcm: Buffer, prompt: string) => voice.transcribe(pcm, prompt),
    canHear: () => voice.canTranscribe(),
    version: app.getVersion(),
  };
}
