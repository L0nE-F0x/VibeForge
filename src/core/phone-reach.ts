import { execFile } from "node:child_process";
import type { PhoneReach } from "../shared/api.js";

// How a phone reaches the phone page: through Tailscale Serve, which this app never sets up itself.
// Settings → Phone only asks the `tailscale` on this computer where things stand, so it can show
// the one step that is left instead of all of them. Nothing here goes over the network: the
// command talks to Tailscale's own service on this machine.

/** The command a person runs once, to share the phone page's port with their own devices. */
export function serveCommand(port: number): string {
  return `sudo tailscale serve --bg --https=443 http://127.0.0.1:${port}`;
}

function parse(json: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(json);
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** True for a handler that passes everything on to the phone page's port on this computer. */
function servesPort(handlers: unknown, port: number): boolean {
  const root = handlers && typeof handlers === "object" ? (handlers as Record<string, unknown>)["/"] : null;
  const proxy = root && typeof root === "object" ? (root as { Proxy?: unknown }).Proxy : null;
  if (typeof proxy !== "string") return false;
  const target = /^(?:https?(?:\+insecure)?:\/\/)?(127\.0\.0\.1|localhost|\[::1\])?:?(\d{1,5})\/?$/.exec(proxy.trim());
  return Number(target?.[2]) === port;
}

/**
 * Where things stand, from `tailscale status --json` and `tailscale serve status --json`.
 * `status` is null when there is no `tailscale` to ask.
 */
export function readReach(status: string | null, serve: string | null, port: number): PhoneReach {
  if (status === null) return { tailscale: "missing", name: null, url: null, funnel: false };
  const state = parse(status);
  const self = state?.Self && typeof state.Self === "object" ? (state.Self as { DNSName?: unknown }) : null;
  const name = typeof self?.DNSName === "string" ? self.DNSName.replace(/\.$/, "").toLowerCase() : "";
  if (state?.BackendState !== "Running" || !name) return { tailscale: "off", name: null, url: null, funnel: false };
  const config = serve ? parse(serve) : null;
  const web = config?.Web && typeof config.Web === "object" ? (config.Web as Record<string, { Handlers?: unknown }>) : {};
  const funnels = config?.AllowFunnel && typeof config.AllowFunnel === "object" ? (config.AllowFunnel as Record<string, unknown>) : {};
  // Only this computer's own name counts: Serve keeps the entries of a name the machine had before
  // (a laptop renamed from "apexforge" to "apexforgelaptop"), and that old name no longer resolves,
  // so a phone sent there gets nothing. The address on 443 first: it is the one without a port to type.
  const allShared = Object.keys(web)
    .filter((host) => host.toLowerCase().replace(/:\d+$/, "") === name && servesPort(web[host]?.Handlers, port))
    .sort((a, b) => Number(b.endsWith(":443")) - Number(a.endsWith(":443")));
  const shared = allShared[0];
  if (!shared) return { tailscale: "on", name, url: null, funnel: false };
  return { tailscale: "on", name, url: `https://${shared.replace(/:443$/, "")}`, funnel: allShared.some((host) => funnels[host] === true) };
}

function ask(args: string[], env: NodeJS.ProcessEnv): Promise<{ out: string; missing: boolean }> {
  return new Promise((resolve) => {
    execFile("tailscale", args, { timeout: 4000, maxBuffer: 4 * 1024 * 1024, env }, (error, stdout) => {
      const missing = Boolean(error && (error as NodeJS.ErrnoException).code === "ENOENT");
      resolve({ out: missing ? "" : String(stdout ?? ""), missing });
    });
  });
}

/** Asks this computer's Tailscale where the phone page can be reached. */
export async function phoneReach(port: number, env: NodeJS.ProcessEnv = process.env): Promise<PhoneReach> {
  const status = await ask(["status", "--json"], env);
  if (status.missing) return readReach(null, null, port);
  const serve = await ask(["serve", "status", "--json"], env);
  return readReach(status.out, serve.out, port);
}
