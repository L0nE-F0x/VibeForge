import path from "node:path";
import { shellQuote } from "../shared/text.js";

// Updates: which release is newest, whether this copy is behind it, and how this copy updates
// itself. Pure; the main process does the asking and runs the command in a terminal.

export const RELEASES_URL = "https://api.github.com/repos/L0nE-F0x/VibeForge/releases/latest";
/** Where each release's files are: `<this>/download/<tag>/install.sh`. */
export const RELEASE_FILES = "https://github.com/L0nE-F0x/VibeForge/releases";
/**
 * The latest release's installer, for when no release has been read yet. The website's /install
 * redirects here too; the app goes to GitHub directly, so the site is never one more thing to trust.
 */
export const INSTALL_URL = `${RELEASE_FILES}/latest/download/install.sh`;
/** The installer leaves this file in the copy it manages; each release's ready-made build carries it too. */
export const INSTALLER_MARK = ".vibeforge-installer";

export interface Release {
  version: string;
  /** Its git tag, "v2.16.0". */
  tag: string;
  name: string;
  url: string;
  notes: string;
  publishedAt: string | null;
  /**
   * Its install.sh, which the in-app Update runs: where to download it, and the SHA-256 GitHub
   * reports for it (null for a release from before GitHub reported them). Null when it has none.
   */
  installer: { url: string; sha256: string | null } | null;
}

/** A tag safe to put in a URL and a shell command as it is: v1.2.3, or v1.2.3-rc.1. */
const TAG = /^v\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/;

/** How this copy got here: the installer, a git checkout someone builds themselves, or anything else. */
export type InstallKind = "installer" | "checkout" | "other";

export function parseVersion(text: string): [number, number, number] | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(text.trim());
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

function prerelease(text: string): string[] | null {
  const match = /^v?\d+\.\d+\.\d+(?:-([0-9A-Za-z.-]+))?/.exec(text.trim());
  if (!match?.[1]) return null;
  return match[1].split(".");
}

/** True when `candidate` is a later version than `current`, following SemVer prerelease precedence. */
export function isNewer(candidate: string, current: string): boolean {
  const a = parseVersion(candidate);
  const b = parseVersion(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  const preA = prerelease(candidate);
  const preB = prerelease(current);
  if (!preA && !preB) return false;
  if (!preA) return true;
  if (!preB) return false;
  for (let i = 0; i < Math.max(preA.length, preB.length); i++) {
    if (i >= preA.length) return false;
    if (i >= preB.length) return true;
    const x = preA[i];
    const y = preB[i];
    if (x === y) continue;
    const numX = /^\d+$/.test(x) ? Number(x) : null;
    const numY = /^\d+$/.test(y) ? Number(y) : null;
    if (numX !== null && numY !== null) return numX > numY;
    if (numX !== null) return false;
    if (numY !== null) return true;
    return x > y;
  }
  return false;
}

/** A release from GitHub's "latest release" answer, or null when the answer isn't one. */
export function releaseFrom(json: unknown): Release | null {
  if (!json || typeof json !== "object") return null;
  const raw = json as Record<string, unknown>;
  const tag = typeof raw.tag_name === "string" ? raw.tag_name.trim() : "";
  if (!parseVersion(tag)) return null;
  return {
    version: tag.replace(/^v/, ""),
    tag,
    name: typeof raw.name === "string" && raw.name.trim() ? raw.name.trim() : `VibeForge ${tag}`,
    url: typeof raw.html_url === "string" ? raw.html_url : "",
    notes: typeof raw.body === "string" ? raw.body.slice(0, 20_000) : "",
    publishedAt: typeof raw.published_at === "string" ? raw.published_at : null,
    installer: installerOf(tag, raw.assets),
  };
}

/**
 * The release's install.sh. Its address is made from the tag rather than taken from the answer, so
 * it can only ever be this repository's own release file; the digest is GitHub's "sha256:<hex>".
 */
function installerOf(tag: string, assets: unknown): Release["installer"] {
  if (!TAG.test(tag) || !Array.isArray(assets)) return null;
  const asset = assets.find((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && (item as Record<string, unknown>).name === "install.sh");
  if (!asset) return null;
  const digest = typeof asset.digest === "string" ? /^sha256:([0-9a-f]{64})$/i.exec(asset.digest.trim()) : null;
  return { url: `${RELEASE_FILES}/download/${tag}/install.sh`, sha256: digest ? digest[1].toLowerCase() : null };
}

export function installKind(appRoot: string, found: { installerHome: string; marked: boolean; checkout: boolean }): InstallKind {
  if (found.marked || path.resolve(appRoot) === path.resolve(found.installerHome)) return "installer";
  return found.checkout ? "checkout" : "other";
}

/**
 * The folder the installer manages for this copy. The installer puts each release in
 * `<install folder>/versions/<version>/` and starts the one `current` links to, so a copy in a
 * versions/ folder belongs to the folder above it. Anything else (an install from before
 * versions/, a checkout) is its own folder.
 */
export function installRoot(appRoot: string): string {
  const resolved = path.resolve(appRoot);
  const up = path.dirname(resolved);
  return path.basename(up) === "versions" ? path.dirname(up) : resolved;
}

/** True for a copy in the installer's versions/ folder, which keeps the version before it for Go back. */
export function inVersions(appRoot: string): boolean {
  return installRoot(appRoot) !== path.resolve(appRoot);
}

/**
 * The version Go back returns to: the one the install folder's `previous` links to, by its
 * package.json, or null when there is none (a copy from before versions/, or a first install).
 * `read` returns a file's text, or null.
 */
export function previousVersion(appRoot: string, read: (file: string) => string | null): string | null {
  if (!inVersions(appRoot)) return null;
  const text = read(path.join(installRoot(appRoot), "previous", "package.json"));
  if (!text) return null;
  try {
    const version = (JSON.parse(text) as { version?: unknown }).version;
    return typeof version === "string" && parseVersion(version) ? version : null;
  } catch {
    return null;
  }
}

/**
 * The shell command Go back runs in a terminal: this version's own install.sh with --rollback,
 * which switches `current` and `previous` and downloads nothing. Null when this copy can't go back.
 */
export function rollbackCommand(kind: InstallKind, appRoot: string): string | null {
  if (kind !== "installer" || !inVersions(appRoot)) return null;
  return `VIBEFORGE_HOME=${shellQuote(installRoot(appRoot))} bash ${shellQuote(path.join(path.resolve(appRoot), "scripts", "install.sh"))} --rollback`;
}

/**
 * How Restart starts VibeForge again. An installer copy (either in versions/ or at the install
 * folder with `.vibeforge-installer`) restarts through the install folder's current launcher, so
 * after an update or Go back it is the version installed now that starts: starting its own
 * Electron with its own folder again would bring back the version it is. Null for any other copy,
 * which restarts as it started. `args` are the restart's arguments (relaunchArgs).
 */
export function restartVia(appRoot: string, args: readonly string[], exists: (file: string) => boolean): { execPath: string; args: string[] } | null {
  const own = path.resolve(appRoot);
  if (!inVersions(appRoot) && !exists(path.join(own, INSTALLER_MARK))) return null;
  const launcher = path.join(installRoot(appRoot), "current", "scripts", "vibeforge");
  if (!exists(launcher)) return null;
  // The launcher adds these itself.
  const added = new Set(["--class=vibeforge", "--enable-wayland-ime"]);
  return { execPath: launcher, args: args.filter((arg) => !added.has(arg) && (arg.startsWith("-") || path.resolve(arg) !== own)) };
}

/** Where a restart starts from: the installer's current launcher when present, else this binary with `args`. */
export function relaunchOptions(
  appRoot: string,
  execPath: string,
  args: readonly string[],
  exists: (file: string) => boolean,
): { execPath: string; args: string[] } {
  return restartVia(appRoot, args, exists) ?? { execPath, args: [...args] };
}

/** GitHub's list of releases for the "latest release" address the update check asks. */
export function releaseListUrl(latestUrl: string): string | null {
  return /\/releases\/latest$/.test(latestUrl) ? latestUrl.replace(/\/latest$/, "?per_page=50") : null;
}

/**
 * The releases after `current` and before `latest`, newest first, from GitHub's release list:
 * what someone who skipped them hasn't read yet. Drafts and pre-releases are left out.
 */
export function releasesBetween(json: unknown, current: string, latest: string): Release[] {
  if (!Array.isArray(json)) return [];
  const found = new Map<string, Release>();
  for (const raw of json) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as Record<string, unknown>;
    if (item.draft === true || item.prerelease === true) continue;
    const release = releaseFrom(item);
    if (release && isNewer(release.version, current) && isNewer(latest, release.version)) found.set(release.version, release);
  }
  return [...found.values()].sort((a, b) => (isNewer(a.version, b.version) ? -1 : 1));
}


/**
 * The shell command that updates this copy, shown and run in a terminal (bash), or null when it
 * updates some other way (a distro package) or when the installer release has no verified SHA-256
 * digest. `override` is for packagers and tests.
 *
 * An installer copy runs the install.sh of the release the update check read, from GitHub over
 * HTTPS only, only after checking it against the SHA-256 GitHub reports for it. A git checkout
 * pulls and builds, with `npm ci` so the lockfile isn't rewritten under the next pull.
 */
export function updateCommand(kind: InstallKind, appRoot: string, override?: string, release?: Release | null): string | null {
  if (override?.trim()) return override.trim();
  // The install folder, not this version's own folder inside it.
  const home = `VIBEFORGE_HOME=${shellQuote(kind === "installer" ? installRoot(appRoot) : appRoot)}`;
  if (kind === "installer") {
    const installer = release?.installer;
    if (!installer?.sha256 || !release || !TAG.test(release.tag)) return null;
    const check = ` && { echo ${shellQuote(`${installer.sha256}  `)}"$f" | sha256sum --check --status || { echo "This installer does not match the checksum GitHub lists for ${release.tag}, so it was not run." >&2; exit 1; }; }`;
    return `f="$(mktemp)" && trap 'rm -f "$f"' EXIT && curl -fsSL --proto =https --proto-redir =https --retry 2 -o "$f" ${shellQuote(installer.url)}${check} && ${home} VIBEFORGE_VERSION=${release.tag} bash "$f"`;
  }
  if (kind === "checkout") return `cd ${shellQuote(appRoot)} && git pull --ff-only && npm ci --no-audit --no-fund && npm run build`;
  return null;
}
