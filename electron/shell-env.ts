import { execFile } from "node:child_process";
import path from "node:path";

const MARKER = "__VIBEFORGE_PATH__";

/**
 * PATH as a login shell sees it. Launched from the app menu, Electron gets a bare PATH
 * without mise or ~/.local/bin; the CLIs VibeForge runs live there. `printenv` reads the
 * exported PATH, which is colon-separated even in fish or nushell, where "$PATH" is a list.
 */
export function loadShellPath(timeoutMs = 4000, shell = process.env.SHELL || "/bin/bash"): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      shell,
      ["-ilc", `printf '%s' '${MARKER}'; printenv PATH; printf '%s' '${MARKER}'`],
      { timeout: timeoutMs, encoding: "utf8", maxBuffer: 1024 * 1024, env: { ...process.env, VIBEFORGE_ENV_PROBE: "1" } },
      (_error, stdout) => resolve(parseShellPath(stdout ?? "")),
    );
  });
}

/** The PATH between the markers, keeping only absolute entries so shell noise can't land in it. */
export function parseShellPath(stdout: string): string | null {
  const match = stdout.match(new RegExp(`${MARKER}([\\s\\S]*?)${MARKER}`));
  const entries = (match?.[1].trim() ?? "").split(path.delimiter).filter((part) => path.isAbsolute(part));
  return entries.length ? entries.join(path.delimiter) : null;
}

/** Login-shell entries first, then anything only the current process had. */
export function mergePath(preferred: string | null, current: string | undefined): string {
  const out: string[] = [];
  for (const part of [...(preferred ?? "").split(path.delimiter), ...(current ?? "").split(path.delimiter)]) {
    if (part && !out.includes(part)) out.push(part);
  }
  return out.join(path.delimiter);
}

/** The environment terminals inherit: the user's, minus what Electron and Vite add. */
export function childEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env };
  for (const key of Object.keys(out)) {
    if (key.startsWith("ELECTRON_") || key.startsWith("VITE_") || key === "CHROME_DESKTOP" || key === "VIBEFORGE_ENV_PROBE") {
      delete out[key];
    }
  }
  if (out.ORIGINAL_XDG_CURRENT_DESKTOP) {
    out.XDG_CURRENT_DESKTOP = out.ORIGINAL_XDG_CURRENT_DESKTOP;
    delete out.ORIGINAL_XDG_CURRENT_DESKTOP;
  }
  return out;
}
