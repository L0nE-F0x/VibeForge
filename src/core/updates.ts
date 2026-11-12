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

/** True when `candidate` is a later version than `current`. */
export function isNewer(candidate: string, current: string): boolean {
  const a = parseVersion(candidate);
  const b = parseVersion(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
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
 * The shell command that updates this copy, shown and run in a terminal (bash), or null when it
 * updates some other way (a distro package). `override` is for packagers and tests.
 *
 * An installer copy runs the install.sh of the release the update check read, from GitHub, after
 * checking it against the SHA-256 GitHub reports for it, and installs that release. Until a
 * release has been read, it runs the latest release's install.sh. A git checkout pulls and builds,
 * with `npm ci` so the lockfile isn't rewritten under the next pull.
 */
export function updateCommand(kind: InstallKind, appRoot: string, override?: string, release?: Release | null): string | null {
  if (override?.trim()) return override.trim();
  const home = `VIBEFORGE_HOME=${shellQuote(appRoot)}`;
  if (kind === "installer") {
    const installer = release?.installer;
    if (installer && TAG.test(release.tag)) {
      const check = installer.sha256
        ? ` && { echo ${shellQuote(`${installer.sha256}  `)}"$f" | sha256sum --check --status || { echo "This installer does not match the checksum GitHub lists for ${release.tag}, so it was not run." >&2; exit 1; }; }`
        : "";
      return `f="$(mktemp)" && trap 'rm -f "$f"' EXIT && curl -fsSL --retry 2 -o "$f" ${shellQuote(installer.url)}${check} && ${home} VIBEFORGE_VERSION=${release.tag} bash "$f"`;
    }
    // pipefail: with no network curl fails and bash reads nothing, which on its own exits 0, and
    // the dialog would offer a restart into the old version.
    return `set -o pipefail; curl -fsSL ${INSTALL_URL} | ${home} bash`;
  }
  if (kind === "checkout") return `cd ${shellQuote(appRoot)} && git pull --ff-only && npm ci --no-audit --no-fund && npm run build`;
  return null;
}
