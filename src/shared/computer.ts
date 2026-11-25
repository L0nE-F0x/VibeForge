// What VibeForge found on this computer, for Settings → This computer and Copy diagnostics: each
// part it depends on, whether it is here, and for one that isn't, what that switches off and the
// line that installs it with this computer's package manager.

export type PackageManager = "pacman" | "apt" | "dnf" | "zypper";

/** The parts VibeForge uses besides the coding CLIs, in the order the card lists them. */
export const COMPUTER_PARTS = ["git", "node", "speech", "piper", "pipewire", "tailscale", "syncthing", "tray", "desktop"] as const;
export type ComputerPart = (typeof COMPUTER_PARTS)[number];

export interface ComputerItem {
  /** A part, or `cli:<engine id>` for a coding CLI. */
  id: string;
  /** A program or product name; not translated. */
  name: string;
  found: boolean;
  version: string | null;
  path: string | null;
}

export interface ComputerFacts {
  /** The coding CLIs found on PATH. */
  clis: ComputerItem[];
  parts: ComputerItem[];
  packageManager: PackageManager | null;
  checkedAt: string;
}

/** The first version number in a program's --version output: "git version 2.47.1" → "2.47.1". */
export function parseVersion(text: string): string | null {
  const match = /\bv?(\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.]+)?)/.exec(text);
  return match ? match[1] : null;
}

/** The desktop by name, from the session's environment; null when it doesn't say. */
export function desktopName(env: Record<string, string | undefined>): string | null {
  if (env.HYPRLAND_INSTANCE_SIGNATURE) return "Hyprland";
  const named = (env.XDG_CURRENT_DESKTOP || env.XDG_SESSION_DESKTOP || env.DESKTOP_SESSION || "").split(":")[0].trim();
  return named || null;
}

/** The package manager the installer would name, found the same way: the first of these on PATH. */
export function packageManagerOf(has: (bin: string) => boolean): PackageManager | null {
  if (has("pacman")) return "pacman";
  if (has("apt-get")) return "apt";
  if (has("dnf")) return "dnf";
  if (has("zypper")) return "zypper";
  return null;
}

/**
 * The line that installs a missing part, or null when there is no one line for it here. Only lines
 * VibeForge already gives elsewhere (the installer, Settings → Voice) or a project's own install
 * command are offered.
 */
export function installLine(part: ComputerPart, manager: PackageManager | null): string | null {
  switch (part) {
    case "git":
      if (manager === "pacman") return "sudo pacman -S --needed git";
      if (manager === "apt") return "sudo apt-get install -y git";
      if (manager === "dnf") return "sudo dnf install -y git";
      if (manager === "zypper") return "sudo zypper install -y git";
      return null;
    case "node":
      return "mise use -g node@lts";
    case "speech":
      return manager === "pacman" ? "sudo pacman -S whisper-cpp" : null;
    case "piper":
      return "uv tool install piper-tts";
    case "pipewire":
      return manager === "pacman" ? "sudo pacman -S --needed pipewire" : null;
    case "tailscale":
      return manager === "pacman" ? "sudo pacman -S tailscale" : "curl -fsSL https://tailscale.com/install.sh | sh";
    default:
      return null;
  }
}

/** The list as plain English lines, for Copy diagnostics. */
export function computerText(facts: ComputerFacts): string[] {
  const line = (item: ComputerItem) => `  ${item.name}: ${item.found ? [item.version ?? "found", item.path].filter(Boolean).join(" · ") : "not found"}`;
  return [
    `This computer (package manager: ${facts.packageManager ?? "unknown"}):`,
    ...(facts.clis.length ? facts.clis.map(line) : ["  No coding CLI on PATH"]),
    ...facts.parts.map(line),
  ];
}
