import { createHash, randomBytes } from "node:crypto";
import type { NetworkInterfaceInfo } from "node:os";

// The words VibeForge and its private Syncthing agree on: ports, ids, the pairing code, the ignore
// file and the name Syncthing gives a file that changed on both machines. Nothing here touches the
// disk or the network; the engine (electron/sync-engine.ts) and the desk (./desk.ts) use it.

/** Where the private Syncthing listens for the other machine. Not Syncthing's own 22000, so a Syncthing you run yourself is left alone. */
export const SYNC_PORT = 22737;
/** Its announcements on the local network, also apart from Syncthing's own 21027. */
export const DISCOVERY_PORT = 21737;

/** How a workspace syncs, seen from this machine: both ways, only out, or only in. */
export type SyncMode = "two" | "send" | "receive";

export const isSyncMode = (value: unknown): value is SyncMode => value === "two" || value === "send" || value === "receive";

/** The same share seen from the other machine. */
export function mirrorMode(mode: SyncMode): SyncMode {
  return mode === "send" ? "receive" : mode === "receive" ? "send" : "two";
}

/** Syncthing's name for a mode. */
export function folderType(mode: SyncMode): "sendreceive" | "sendonly" | "receiveonly" {
  return mode === "send" ? "sendonly" : mode === "receive" ? "receiveonly" : "sendreceive";
}

// ------------------------------------------------------------------ machines

const DEVICE_ID = /^[A-Z2-7]{7}(-[A-Z2-7]{7}){7}$/;

/** A Syncthing device id, tidied (spaces, case, missing dashes), or null when it isn't one. */
export function deviceId(text: string): string | null {
  const plain = text.toUpperCase().replace(/[^A-Z2-7]/g, "");
  if (plain.length !== 56) return null;
  const id = plain.match(/.{7}/g)?.join("-") ?? "";
  return DEVICE_ID.test(id) ? id : null;
}

/** The start of a device id: what Syncthing puts in file names and logs. */
export const shortId = (id: string): string => id.slice(0, 7);

/** `host:port` for an address someone typed or a machine announced; null for anything else. */
export function hostPort(text: string, fallbackPort = SYNC_PORT): string | null {
  const value = text.trim().replace(/^tcp:\/\//i, "");
  if (!value || /[\s/@,]/.test(value)) return null;
  // [v6]:port, v6 without a port, or host[:port].
  const bracketed = /^\[([0-9a-f:.]+)\](?::(\d{1,5}))?$/i.exec(value);
  if (bracketed) return `[${bracketed[1]}]:${validPort(bracketed[2]) ?? fallbackPort}`;
  if ((value.match(/:/g) ?? []).length > 1) return /^[0-9a-f:.]+$/i.test(value) ? `[${value}]:${fallbackPort}` : null;
  const [host, port] = value.split(":");
  if (!/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/i.test(host)) return null;
  if (port !== undefined && !validPort(port)) return null;
  return `${host}:${validPort(port) ?? fallbackPort}`;
}

function validPort(text: string | undefined): number | null {
  if (!text || !/^\d{1,5}$/.test(text)) return null;
  const port = Number(text);
  return port >= 1 && port <= 65535 ? port : null;
}

/** What Syncthing dials: `tcp://host:port`. */
export const dialAddress = (address: string): string => `tcp://${address}`;

/**
 * The code one machine shows and the other pastes: the device id, then where it can be reached
 * (`ID@192.168.1.20:22737,100.64.0.3:22737`). The id alone works too, on one local network.
 */
export function pairingCode(id: string, addresses: readonly string[]): string {
  return addresses.length ? `${id}@${addresses.join(",")}` : id;
}

export function parsePairingCode(text: string): { id: string; addresses: string[] } | null {
  const [idPart, ...rest] = text.trim().split("@");
  const id = deviceId(idPart ?? "");
  if (!id) return null;
  const addresses = rest
    .join("@")
    .split(",")
    .map((item) => hostPort(item))
    .filter((item): item is string => Boolean(item));
  return { id, addresses: [...new Set(addresses)].slice(0, 8) };
}

/**
 * Where this machine can be reached, for its pairing code: its IPv4 addresses on real networks and
 * on a tailnet (100.64.0.0/10 first, since it works from anywhere), never loopback or link-local.
 */
export function machineAddresses(interfaces: NodeJS.Dict<NetworkInterfaceInfo[]>, port = SYNC_PORT): string[] {
  const found: Array<{ address: string; tailnet: boolean }> = [];
  for (const [name, rows] of Object.entries(interfaces)) {
    // Containers' and VMs' bridges lead nowhere another machine can reach.
    if (/^(docker|br-|veth|virbr|lo$)/.test(name)) continue;
    for (const row of rows ?? []) {
      if (row.internal || row.family !== "IPv4" || row.address.startsWith("169.254.")) continue;
      found.push({ address: row.address, tailnet: isTailnet(row.address) });
    }
  }
  found.sort((a, b) => Number(b.tailnet) - Number(a.tailnet));
  return [...new Set(found.map((row) => `${row.address}:${port}`))].slice(0, 4);
}

function isTailnet(address: string): boolean {
  const [a, b] = address.split(".").map(Number);
  return a === 100 && b >= 64 && b <= 127;
}

/**
 * The command that lets paired machines through this machine's firewall, when ufw (Omarchy's
 * firewall) is on and hasn't been told yet; null when nothing needs doing. `conf` and `rules` are
 * ufw's own files, which anyone may read. Only one of two machines has to let the other in, but
 * on a laptop and a desktop there is no telling which one will be dialled.
 */
export function firewallCommand(conf: string, rules: string, port = SYNC_PORT, discoveryPort = DISCOVERY_PORT): string | null {
  if (!/^\s*ENABLED\s*=\s*yes\s*$/im.test(conf)) return null;
  const open = (protocol: string, wanted: number) => new RegExp(`^-A ufw-user-input -p ${protocol} --dport ${wanted} -j ACCEPT\\s*$`, "m").test(rules);
  if (open("tcp", port)) return null;
  return `sudo ufw allow ${port}/tcp && sudo ufw allow ${discoveryPort}/udp`;
}

// ------------------------------------------------------------------ folders

/** A new workspace share's id. Both machines use the same one. */
export function newFolderId(random: () => Buffer = () => randomBytes(8)): string {
  return `vf-ws-${random().toString("hex").slice(0, 12)}`;
}

/** The small private folder two paired machines keep between them: the same id on both, from their ids. */
export function linkFolderId(a: string, b: string): string {
  return `vf-link-${createHash("sha256").update([a, b].sort().join("|")).digest("hex").slice(0, 16)}`;
}

/** A folder VibeForge made in its Syncthing; anything else there isn't touched. */
export const isOurFolder = (id: string): boolean => id.startsWith("vf-ws-") || id.startsWith("vf-link-");

// ------------------------------------------------------------------ what stays on each machine

/** Built per machine, heavy, or holding absolute paths: never synced. */
export const DEFAULT_IGNORES = ["node_modules", "target", ".venv"] as const;

const IGNORE_START = "// VibeForge sync: these lines are VibeForge's. Add your own below the end mark.";
const IGNORE_END = "// VibeForge sync: end";

/**
 * The lines VibeForge keeps in a synced folder's `.stignore`. `(?d)` lets Syncthing delete an
 * ignored folder's contents when the folder holding it is removed on the other machine.
 */
export function ignoreLines(options: { filesOnly: boolean }): string[] {
  return [
    ...DEFAULT_IGNORES.map((name) => `(?d)${name}`),
    // Syncthing's copy of a file that changed on both machines stays on the machine that made it,
    // where VibeForge picks it up; the other machine never sees it.
    "*.sync-conflict-*",
    ...(options.filesOnly
      ? ["(?d).git"]
      : [
          // A task's copy is registered here with this machine's own paths.
          ".git/worktrees",
          // Git's locks are held for moments; synced, they would stop git on the other machine.
          ".git/*.lock",
          ".git/**/*.lock",
          ".git/gc.pid",
        ]),
  ];
}

/** `.stignore` with VibeForge's lines put in (or replaced), and whatever else its author wrote kept. */
export function mergeIgnoreFile(existing: string, lines: readonly string[]): string {
  const block = [IGNORE_START, ...lines, IGNORE_END];
  const rows = existing.split("\n");
  const start = rows.indexOf(IGNORE_START);
  const end = rows.indexOf(IGNORE_END);
  const own = start >= 0 && end > start ? [...rows.slice(0, start), ...rows.slice(end + 1)] : rows;
  const kept = own.join("\n").trim();
  return `${block.join("\n")}\n${kept ? `${kept}\n` : ""}`;
}

/** `.stignore` once a folder stops syncing: VibeForge's lines gone; empty when nothing else was in it. */
export function withoutIgnoreBlock(existing: string): string {
  const rows = existing.split("\n");
  const start = rows.indexOf(IGNORE_START);
  const end = rows.indexOf(IGNORE_END);
  if (start < 0 || end <= start) return existing;
  const kept = [...rows.slice(0, start), ...rows.slice(end + 1)].join("\n").trim();
  return kept ? `${kept}\n` : "";
}

// ------------------------------------------------------------------ a file that changed on both machines

export interface ConflictName {
  /** The file the copy is of. */
  original: string;
  /** When Syncthing made it, as `YYYYMMDD-HHMMSS`. */
  stamp: string;
  /** The start of the id of the machine whose version won; the copy holds the other one's. */
  winner: string;
}

const CONFLICT = /^(.*)\.sync-conflict-(\d{8}-\d{6})-([A-Z2-7]{7})(\.[^./]*)?$/;

/** Reads `notes.sync-conflict-20261117-204452-MTOM47S.md` (or `.sync-conflict-...env` for dotfiles) as a copy of the original; null otherwise. */
export function conflictName(name: string): ConflictName | null {
  const found = CONFLICT.exec(name);
  if (!found) return null;
  // Syncthing names dotfiles `.sync-conflict-<stamp>-<id>.<dotname>`, leaving group 1 empty.
  const original = `${found[1]}${found[4] ?? ""}`;
  if (!original || original === ".") return null;
  return { original, stamp: found[2], winner: found[3] };
}

// ------------------------------------------------------------------ the private Syncthing's settings

export interface LockOptions {
  /** `tcp://:22737`, or a loopback address in tests. */
  listen: string;
  /** Announce on the local network so a paired machine on it is found without an address. */
  discovery: boolean;
  discoveryPort?: number;
}

/**
 * A Syncthing `config.xml` with everything that reaches outside turned off: no global discovery,
 * no relays, no NAT traversal, no usage or crash reports, no upgrades, no browser. Applied before
 * every start, so nothing in the file can turn them back on.
 */
export function lockDown(xml: string, options: LockOptions): string {
  const port = options.discoveryPort ?? DISCOVERY_PORT;
  const wanted: Array<[string, string]> = [
    ["listenAddress", options.listen],
    ["globalAnnounceEnabled", "false"],
    ["localAnnounceEnabled", String(options.discovery)],
    ["localAnnouncePort", String(port)],
    ["localAnnounceMCAddr", `[ff12::8384]:${port}`],
    ["relaysEnabled", "false"],
    ["natEnabled", "false"],
    ["urAccepted", "-1"],
    ["urSeen", "3"],
    ["autoUpgradeIntervalH", "0"],
    ["crashReportingEnabled", "false"],
    ["startBrowser", "false"],
  ];
  const body = /<options>([\s\S]*?)<\/options>/.exec(xml);
  if (!body) throw new Error("Syncthing's settings file has no options to set.");
  let inner = body[1];
  for (const [name, value] of wanted) {
    const tag = new RegExp(`<${name}>[^<]*</${name}>`, "g");
    const line = `<${name}>${value}</${name}>`;
    // A setting listed twice (several listen addresses) becomes one.
    let seen = false;
    inner = inner.replace(tag, () => {
      if (seen) return "";
      seen = true;
      return line;
    });
    if (!seen) inner = `\n        ${line}${inner}`;
  }
  return xml.replace(body[0], `<options>${inner}</options>`);
}
