import { execFile } from "node:child_process";
import fs from "node:fs";
import { whichBin } from "../src/core/engines.js";
import type { Engine } from "../src/core/types.js";
import { type ComputerFacts, type ComputerItem, desktopName, packageManagerOf, parseVersion } from "../src/shared/computer.js";

// Settings → This computer: looks for each part VibeForge depends on, when the card asks (never in
// the background). A version comes from the program's own --version, cut off after a few seconds.

/** What the rest of the main process already knows. */
export interface ComputerInputs {
  engines: Engine[];
  voice: { server: string | null; cli: string | null; sherpa?: string | null; piper: string | null; recorder: string | null };
  trayHost: boolean;
  syncthing: { path: string; version: string };
  env?: NodeJS.ProcessEnv;
  /** Runs `bin args` and gives back what it printed; a test hands in its own. */
  run?: (bin: string, args: string[]) => Promise<string>;
}

const VERSION_MS = 3000;

function runFor(bin: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout: VERSION_MS, encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } }, (_error, stdout, stderr) => resolve(`${stdout ?? ""}\n${stderr ?? ""}`));
  });
}

export async function probeComputer(inputs: ComputerInputs): Promise<ComputerFacts> {
  const env = inputs.env ?? process.env;
  const run = inputs.run ?? runFor;
  const which = (bin: string) => whichBin(bin, env.PATH ?? "");
  const versionOf = async (path: string | null, args = ["--version"]) => (path ? parseVersion(await run(path, args)) : null);
  const item = async (id: string, name: string, path: string | null, args?: string[]): Promise<ComputerItem> => ({ id, name, found: Boolean(path), version: await versionOf(path, args), path });

  const clis = Promise.all(inputs.engines.filter((engine) => engine.available).map((engine) => item(`cli:${engine.id}`, engine.label, engine.path)));
  const node = env.VIBEFORGE_NODE || which("node");
  const speech = inputs.voice.server ?? inputs.voice.cli ?? inputs.voice.sherpa ?? null;
  const pipewire = which("pw-record") ?? (inputs.voice.recorder === "pw-record" ? "pw-record" : null);
  const syncthing = fs.existsSync(inputs.syncthing.path) ? inputs.syncthing.path : null;
  const desktop = desktopName(env);
  const parts = Promise.all([
    item("git", "git", which("git")),
    item("node", "Node", node),
    // whisper.cpp and sherpa-onnx print no version they can be asked for without loading a model.
    Promise.resolve({ id: "speech", name: speech && speech === inputs.voice.sherpa ? "sherpa-onnx" : "whisper.cpp", found: Boolean(speech), version: null, path: speech }),
    Promise.resolve({ id: "piper", name: "Piper", found: Boolean(inputs.voice.piper), version: null, path: inputs.voice.piper }),
    Promise.resolve({ id: "pipewire", name: "PipeWire", found: Boolean(pipewire), version: null, path: pipewire }),
    item("tailscale", "Tailscale", which("tailscale"), ["version"]),
    Promise.resolve({ id: "syncthing", name: "Syncthing", found: Boolean(syncthing), version: syncthing ? inputs.syncthing.version || null : null, path: syncthing }),
    Promise.resolve({ id: "tray", name: "Tray host", found: inputs.trayHost, version: null, path: null }),
    Promise.resolve({ id: "desktop", name: desktop ?? "Desktop", found: Boolean(desktop), version: null, path: null }),
  ]);
  return { clis: await clis, parts: await parts, packageManager: packageManagerOf((bin) => Boolean(which(bin))), checkedAt: new Date().toISOString() };
}
