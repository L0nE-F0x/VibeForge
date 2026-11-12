import { spawn } from "node:child_process";
import path from "node:path";

const MARKER = "__VIBEFORGE_PATH__";

/**
 * PATH as a login shell sees it. Launched from the app menu, Electron gets a bare PATH
 * without mise or ~/.local/bin; the CLIs VibeForge runs live there. `printenv` reads the
 * exported PATH, which is colon-separated even in fish or nushell, where "$PATH" is a list.
 *
 * Start-up waits on this, so the cap is a hard one: an interactive bash ignores SIGTERM, and a
 * profile that reads stdin would wait for ever, so stdin is closed, the shell leads a process
 * group of its own, and on the cap the whole group is killed and the answer is null whether or not
 * the shell has gone yet.
 */
export function loadShellPath(timeoutMs = 4000, shell = process.env.SHELL || "/bin/bash"): Promise<string | null> {
  return new Promise((resolve) => {
    let out = "";
    let settled = false;
    const finish = (value: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(shell, ["-ilc", `printf '%s' '${MARKER}'; printenv PATH; printf '%s' '${MARKER}'`], {
        stdio: ["ignore", "pipe", "ignore"],
        detached: true,
        env: { ...process.env, VIBEFORGE_ENV_PROBE: "1" },
      });
    } catch {
      resolve(null);
      return;
    }
    const timer = setTimeout(() => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
      } catch {
        /* already gone */
      }
      finish(null);
    }, timeoutMs);
    child.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
      if (out.length < 1024 * 1024) out += chunk;
    });
    child.on("error", () => finish(null));
    child.on("close", () => finish(parseShellPath(out)));
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

/**
 * VibeForge's own debug switches. VIBEFORGE_DEBUG opens a DevTools port on the window; a terminal
 * that kept it would hand it on to any VibeForge started from there.
 */
const NOT_INHERITED = new Set(["CHROME_DESKTOP", "VIBEFORGE_ENV_PROBE", "VIBEFORGE_DEBUG", "VIBEFORGE_DEBUG_PORT"]);

/** The environment terminals inherit: the user's, minus what Electron, Vite and VibeForge's debugging add. */
export function childEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env };
  for (const key of Object.keys(out)) {
    if (key.startsWith("ELECTRON_") || key.startsWith("VITE_") || NOT_INHERITED.has(key)) delete out[key];
  }
  return out;
}
