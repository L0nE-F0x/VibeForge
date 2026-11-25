import path from "node:path";
import type { PackageManager } from "../shared/computer.js";
import { validateKeyCombo, type ComputerActionKind, type ComputerSurface } from "../shared/computer-use.js";
import { fuzzyMatchName } from "../shared/orchestrator-fuzzy.js";

export interface DesktopWindowInfo {
  address: string;
  class: string;
  title: string;
  workspace: string;
  at: [number, number];
  size: [number, number];
  focused: boolean;
}

export interface DesktopMonitorInfo {
  name: string;
  width: number;
  height: number;
  x: number;
  y: number;
  scale: number;
  focused: boolean;
}

export interface ScreenshotResult {
  path: string;
  width?: number;
  height?: number;
  surface: ComputerSurface;
  summary: string;
  details: string;
}

export interface ComputerUseCapabilities {
  platform: string;
  sessionType: "wayland" | "x11" | "other";
  compositor: "hyprland" | "wayland" | "x11" | "none";
  canScreenshot: boolean;
  canListWindows: boolean;
  canPointer: boolean;
  canKeyboard: boolean;
  canAppUi: boolean;
}

export interface ComputerActionRequest {
  action: ComputerActionKind;
  surface: ComputerSurface;
  target: string;
  prompt: string;
  options?: string;
}

export interface ComputerUseDriver {
  capabilities(): Promise<ComputerUseCapabilities>;
  screenshot(opts?: { surface?: ComputerSurface; target?: string }): Promise<ScreenshotResult>;
  listWindows(): Promise<DesktopWindowInfo[]>;
  act(req: ComputerActionRequest): Promise<string>;
}

/**
 * Parses `hyprctl -j monitors` output into clean monitor geometry rows.
 */
export function parseHyprctlMonitors(rawJson: string): DesktopMonitorInfo[] {
  try {
    const parsed: unknown = JSON.parse(rawJson);
    if (!Array.isArray(parsed)) return [];
    const out: DesktopMonitorInfo[] = [];
    for (const row of parsed) {
      if (!row || typeof row !== "object") continue;
      const r = row as Record<string, unknown>;
      if (typeof r.name !== "string" || typeof r.width !== "number" || typeof r.height !== "number") continue;
      out.push({
        name: r.name,
        width: r.width,
        height: r.height,
        x: typeof r.x === "number" ? r.x : 0,
        y: typeof r.y === "number" ? r.y : 0,
        scale: typeof r.scale === "number" && r.scale > 0 ? r.scale : 1,
        focused: Boolean(r.focused),
      });
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * Parses `hyprctl -j clients` JSON output into open mapped windows.
 */
export function parseHyprctlClients(rawJson: string): DesktopWindowInfo[] {
  try {
    const parsed: unknown = JSON.parse(rawJson);
    if (!Array.isArray(parsed)) return [];
    const out: DesktopWindowInfo[] = [];
    for (const row of parsed) {
      if (!row || typeof row !== "object") continue;
      const r = row as Record<string, unknown>;
      if (r.mapped === false || typeof r.address !== "string") continue;
      const atRaw = Array.isArray(r.at) && r.at.length >= 2 && typeof r.at[0] === "number" && typeof r.at[1] === "number" ? ([r.at[0], r.at[1]] as [number, number]) : ([0, 0] as [number, number]);
      const sizeRaw =
        Array.isArray(r.size) && r.size.length >= 2 && typeof r.size[0] === "number" && typeof r.size[1] === "number"
          ? ([r.size[0], r.size[1]] as [number, number])
          : ([0, 0] as [number, number]);
      const wsObj = r.workspace && typeof r.workspace === "object" ? (r.workspace as Record<string, unknown>) : null;
      const wsName = typeof wsObj?.name === "string" ? wsObj.name : typeof wsObj?.id === "number" ? String(wsObj.id) : "";
      const focusHist = typeof r.focusHistoryID === "number" ? r.focusHistoryID : -1;
      out.push({
        address: r.address,
        class: typeof r.class === "string" ? r.class : "",
        title: typeof r.title === "string" ? r.title : "",
        workspace: wsName,
        at: atRaw,
        size: sizeRaw,
        focused: focusHist === 0,
      });
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * Finds an unambiguous desktop window by address, class, title, or fuzzy/phonetic match.
 */
export function matchDesktopWindow(query: string, windows: readonly DesktopWindowInfo[]): DesktopWindowInfo | null {
  const trimmed = query.trim();
  if (!trimmed || !windows.length) return null;
  const exactAddr = windows.find((w) => w.address.toLowerCase() === trimmed.toLowerCase());
  if (exactAddr) return exactAddr;
  const lower = trimmed.toLowerCase();
  const exact = windows.filter((w) => w.title.toLowerCase() === lower || w.class.toLowerCase() === lower);
  if (exact.length === 1) return exact[0];
  const contains = windows.filter((w) => `${w.class} ${w.title}`.toLowerCase().includes(lower));
  if (contains.length === 1) return contains[0];
  return fuzzyMatchName(trimmed, windows, (w) => [w.title, w.class, `${w.class} ${w.title}`].filter(Boolean), true);
}

export type HyprConfigProvider = "hyprlang" | "lua";

export type HyprDispatchCommand =
  | { kind: "workspace"; workspace: string }
  | { kind: "focuswindow"; selector: string }
  | { kind: "movecursor"; x: number; y: number };

/**
 * Detects whether Hyprland uses traditional hyprlang or 0.56+ Lua config/dispatch syntax
 * from `hyprctl status`.
 */
export function parseHyprConfigProvider(statusOutput: string): HyprConfigProvider {
  return /^\s*configProvider:\s*lua\b/im.test(statusOutput) ? "lua" : "hyprlang";
}

/**
 * Detects Hyprland 0.56+ Lua dispatch syntax error output when a legacy hyprlang dispatch was sent.
 */
export function isHyprLuaDispatchError(text: string): boolean {
  return /\bhl\.dispatch\b|dispatch in lua/i.test(text);
}

/**
 * Escapes regex metacharacters for Hyprland `title:...` / `class:...` window selectors.
 */
export function escapeHyprRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Encodes a string as a double-quoted Lua string literal.
 */
export function quoteLuaString(value: string): string {
  const escaped = value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t")
    .replace(/\0/g, "\\0");
  return `"${escaped}"`;
}

/**
 * Builds the fallback Hyprland window selector using regex-escaped exact title or class.
 */
export function buildHyprFallbackFocusSelector(win: Pick<DesktopWindowInfo, "title" | "class">): string | null {
  if (win.title.trim()) return `title:^${escapeHyprRegex(win.title)}$`;
  if (win.class.trim()) return `class:^${escapeHyprRegex(win.class)}$`;
  return null;
}

/**
 * Builds the preferred Hyprland `focuswindow` selector, preferring `address:0x...` when available.
 */
export function buildHyprFocusSelector(win: Pick<DesktopWindowInfo, "address" | "title" | "class">): string | null {
  const addr = win.address.trim();
  if (/^0x[0-9a-f]+$/i.test(addr)) return `address:${addr}`;
  return buildHyprFallbackFocusSelector(win);
}

/**
 * Recognizes `Super+<digit>` workspace-switching shortcuts (`Super+1`..`Super+9`, `Super+0` -> `"10"`).
 */
export function parseHyprWorkspaceShortcut(raw: string): string | null {
  const combo = validateKeyCombo(raw);
  if (!combo || combo.modifiers.length !== 1 || combo.modifiers[0] !== "super") return null;
  if (!/^[0-9]$/.test(combo.key)) return null;
  return combo.key === "0" ? "10" : combo.key;
}

/**
 * Builds `hyprctl` arguments for hyprlang or Hyprland 0.56+ Lua dispatch mode.
 */
export function buildHyprDispatchArgs(mode: HyprConfigProvider, cmd: HyprDispatchCommand): string[] {
  if (mode === "lua") {
    if (cmd.kind === "workspace") return ["dispatch", `hl.dsp.focus({ workspace = ${quoteLuaString(cmd.workspace)} })`];
    if (cmd.kind === "focuswindow") return ["dispatch", `hl.dsp.focus({ window = ${quoteLuaString(cmd.selector)} })`];
    return ["dispatch", `hl.dsp.cursor.move({ x = ${Math.round(cmd.x)}, y = ${Math.round(cmd.y)} })`];
  }
  if (cmd.kind === "workspace") return ["dispatch", "workspace", cmd.workspace];
  if (cmd.kind === "focuswindow") return ["dispatch", "focuswindow", cmd.selector];
  return ["dispatch", "movecursor", String(Math.round(cmd.x)), String(Math.round(cmd.y))];
}

/**
 * Extracts a failure/warning message when `hyprctl dispatch` returns exit 0 with non-`ok` output.
 */
export function hyprDispatchFailureReason(stdout: string, stderr: string): string | null {
  const out = stdout.trim();
  const err = stderr.trim();
  if (out && out.toLowerCase() !== "ok") return [err, out].filter(Boolean).join("\n");
  if (err) return err;
  return null;
}

/**
 * Converts physical screenshot pixel coordinates to Hyprland logical layout coordinates using the
 * target monitor's scale and layout origin.
 */
export function screenshotToLogicalCoords(
  coords: { x: number; y: number },
  monitor: Pick<DesktopMonitorInfo, "x" | "y" | "scale"> | null | undefined,
): { x: number; y: number } {
  if (!monitor) return { x: Math.round(coords.x), y: Math.round(coords.y) };
  const scale = Number.isFinite(monitor.scale) && monitor.scale > 0 ? monitor.scale : 1;
  return {
    x: Math.round(monitor.x + coords.x / scale),
    y: Math.round(monitor.y + coords.y / scale),
  };
}

const WTYPE_MODIFIER: Record<"ctrl" | "alt" | "shift" | "super", string> = {
  ctrl: "ctrl",
  alt: "alt",
  shift: "shift",
  super: "logo",
};

const WTYPE_KEYSYM: Record<string, string> = {
  ".": "period",
  ",": "comma",
  "/": "slash",
  _: "underscore",
  "-": "minus",
};

/**
 * Builds an argv list (never a shell string) for `wtype`.
 * Translates `"super"` to `wtype`'s `"logo"` modifier and punctuation chars to XKB keysym names.
 */
export function buildWtypeArgs(mode: "type" | "key", value: string): string[] | null {
  if (mode === "type") {
    if (!value || value.length > 2000) return null;
    return ["--", value];
  }
  const combo = validateKeyCombo(value);
  if (!combo) return null;
  const mods = combo.modifiers.map((mod) => WTYPE_MODIFIER[mod]);
  const key = WTYPE_KEYSYM[combo.key] ?? combo.key;
  const args: string[] = [];
  for (const mod of mods) args.push("-M", mod);
  args.push("-k", key);
  for (const mod of [...mods].reverse()) args.push("-m", mod);
  return args;
}

const EVDEV_MODIFIER: Record<"ctrl" | "alt" | "shift" | "super", number> = {
  ctrl: 29,
  shift: 42,
  alt: 56,
  super: 125,
};

const EVDEV_KEYCODE: Record<string, number> = {
  a: 30,
  b: 48,
  c: 46,
  d: 32,
  e: 18,
  f: 33,
  g: 34,
  h: 35,
  i: 23,
  j: 36,
  k: 37,
  l: 38,
  m: 50,
  n: 49,
  o: 24,
  p: 25,
  q: 16,
  r: 19,
  s: 31,
  t: 20,
  u: 22,
  v: 47,
  w: 17,
  x: 45,
  y: 21,
  z: 44,
  "1": 2,
  "2": 3,
  "3": 4,
  "4": 5,
  "5": 6,
  "6": 7,
  "7": 8,
  "8": 9,
  "9": 10,
  "0": 11,
  "-": 12,
  ",": 51,
  ".": 52,
  "/": 53,
  Escape: 1,
  BackSpace: 14,
  Tab: 15,
  Return: 28,
  space: 57,
  F1: 59,
  F2: 60,
  F3: 61,
  F4: 62,
  F5: 63,
  F6: 64,
  F7: 65,
  F8: 66,
  F9: 67,
  F10: 68,
  F11: 87,
  F12: 88,
  Home: 102,
  Up: 103,
  Prior: 104,
  Left: 105,
  Right: 106,
  End: 107,
  Down: 108,
  Next: 109,
  Insert: 110,
  Delete: 111,
};

/**
 * Builds an argv list (never a shell string) for `ydotool` keyboard actions.
 */
export function buildYdotoolKeyArgs(mode: "type" | "key", value: string): string[] | null {
  if (mode === "type") {
    if (!value || value.length > 2000) return null;
    return ["type", "--", value];
  }
  const combo = validateKeyCombo(value);
  if (!combo) return null;
  const down = combo.modifiers.map((mod) => EVDEV_MODIFIER[mod]);
  if (combo.key === "_") {
    if (!down.includes(EVDEV_MODIFIER.shift)) down.push(EVDEV_MODIFIER.shift);
    down.push(EVDEV_KEYCODE["-"]);
  } else {
    const code = EVDEV_KEYCODE[combo.key];
    if (code === undefined) return null;
    down.push(code);
  }
  const presses = down.map((code) => `${code}:1`);
  const releases = [...down].reverse().map((code) => `${code}:0`);
  return ["key", ...presses, ...releases];
}

const DOTOOL_KEY: Record<string, string> = {
  Return: "enter",
  Escape: "esc",
  Tab: "tab",
  BackSpace: "backspace",
  Delete: "delete",
  space: "space",
  Up: "up",
  Down: "down",
  Left: "left",
  Right: "right",
  Home: "home",
  End: "end",
  Prior: "pageup",
  Next: "pagedown",
  Insert: "insert",
  ".": "dot",
  ",": "comma",
  "/": "slash",
  "-": "minus",
};

/**
 * Builds stdin command lines for `dotool` keyboard actions.
 */
export function buildDotoolInput(mode: "type" | "key", value: string): string | null {
  if (mode === "type") {
    if (!value || value.length > 2000) return null;
    const lines = value.split(/\r?\n/);
    const commands: string[] = [];
    for (let i = 0; i < lines.length; i += 1) {
      if (lines[i]) commands.push(`type ${lines[i]}`);
      if (i + 1 < lines.length) commands.push("key enter");
    }
    return commands.length ? `${commands.join("\n")}\n` : null;
  }
  const combo = validateKeyCombo(value);
  if (!combo) return null;
  const mods: string[] = [...combo.modifiers];
  let keyName: string;
  if (combo.key === "_") {
    if (!mods.includes("shift")) mods.push("shift");
    keyName = "minus";
  } else {
    keyName = DOTOOL_KEY[combo.key] ?? combo.key.toLowerCase();
  }
  return `key ${[...mods, keyName].join("+")}\n`;
}

/**
 * Builds stdin command lines for `dotool` pointer click or wheel actions.
 */
export function buildDotoolPointerInput(op: "click" | "double-click" | "right-click" | "scroll-v" | "scroll-h", arg?: number): string {
  if (op === "click") return "click left\n";
  if (op === "double-click") return "click left\nclick left\n";
  if (op === "right-click") return "click right\n";
  if (op === "scroll-v") return `wheel ${arg ?? 0}\n`;
  return `hwheel ${arg ?? 0}\n`;
}

/**
 * Formats a concise install command hint for missing desktop automation packages.
 */
export function installHintFor(packages: readonly string[], manager: PackageManager | null): string {
  const pkgs = packages.filter(Boolean).join(" ");
  if (!pkgs) return "";
  if (manager === "pacman") return `Install with: sudo pacman -S ${pkgs}`;
  if (manager === "apt") return `Install with: sudo apt-get install -y ${pkgs}`;
  if (manager === "dnf") return `Install with: sudo dnf install -y ${pkgs}`;
  if (manager === "zypper") return `Install with: sudo zypper install -y ${pkgs}`;
  return `Install ${pkgs} with your system package manager.`;
}

function summarizeCommandArgs(args: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (i > 0 && args[i - 1] === "-c" && arg.includes("UI_DEV_SETUP")) {
      out.push("<uinput-helper>");
    } else {
      out.push(arg.length > 160 ? `${arg.slice(0, 157)}...` : arg);
    }
  }
  return out;
}

/**
 * Formats a full command failure with exit/signal status, stderr + stdout, and an actionable hint.
 */
export function formatComputerCommandError(opts: {
  file: string;
  args: readonly string[];
  code?: number | string | null;
  signal?: string | null;
  killed?: boolean;
  stdout?: string;
  stderr?: string;
  message?: string;
  hint?: string;
}): string {
  const cmdStr = [opts.file, ...summarizeCommandArgs(opts.args)].join(" ");
  const status =
    opts.code === "ENOENT"
      ? `(binary "${path.basename(opts.file)}" not found)`
      : opts.killed
        ? "(timed out)"
        : typeof opts.code === "number"
          ? `(exit ${opts.code})`
          : opts.code
            ? `(${opts.code})`
            : opts.signal
              ? `(signal ${opts.signal})`
              : "";

  const stderr = (opts.stderr ?? "").trim();
  const stdout = (opts.stdout ?? "").trim();
  const outputParts: string[] = [];
  if (stderr) outputParts.push(stderr);
  if (stdout && stdout !== stderr) outputParts.push(stdout);
  let output = outputParts.join("\n").trim();
  if (!output && opts.message) {
    const cleaned = opts.message.replace(/^Command failed:[^\n]*\n?/, "").trim();
    if (cleaned) output = cleaned;
  }
  if (output.length > 1200) output = `${output.slice(0, 1197)}...`;

  let autoHint = "";
  if (!opts.hint) {
    if (opts.code === "ENOENT") {
      autoHint = `Missing binary "${path.basename(opts.file)}".`;
    } else if (/virtual[-_\s]*keyboard|not supported|compositor does not support/i.test(output)) {
      autoHint = "The Wayland compositor may not support the virtual-keyboard protocol; install ydotool or dotool as a fallback.";
    } else if (/ydotool/i.test(opts.file) && /ydotoold|failed to connect|socket/i.test(output)) {
      autoHint = "Ensure the ydotoold daemon is running (e.g. systemctl --user enable --now ydotool) or install wtype / dotool.";
    } else if (/uinput/i.test(output) && /(?:permission|eacces|eperm)/i.test(output)) {
      autoHint = "Grant read/write access to /dev/uinput (udev rule or input group) or install ydotool / dotool.";
    }
  }
  const hint = (opts.hint ?? autoHint).trim();

  const lines = [`Command failed${status ? ` ${status}` : ""}: ${cmdStr}`];
  if (output) lines.push(output);
  if (hint) lines.push(`Hint: ${hint}`);
  return lines.join("\n");
}

/**
 * Appends a `Hint:` line to a command error message unless a hint is already present.
 */
export function appendComputerHint(message: string, hint: string): string {
  const clean = hint.trim();
  if (!clean || message.includes("Hint:")) return message;
  return `${message}\nHint: ${clean}`;
}

/**
 * Isolated Python 3 helper using `/dev/uinput` (`python3 -I -c <script> <op> <arg1>`),
 * emitting mouse clicks, press/release, or scroll events without shell interpolation.
 */
export const UINPUT_HELPER_SCRIPT = `
import fcntl, os, struct, sys, time
UI_SET_EVBIT = 0x40045564
UI_SET_KEYBIT = 0x40045565
UI_SET_RELBIT = 0x40045566
UI_DEV_SETUP = 0x405c5503
UI_DEV_CREATE = 0x5501
UI_DEV_DESTROY = 0x5502
EV_SYN, EV_KEY, EV_REL = 0, 1, 2
BTN_LEFT, BTN_RIGHT, BTN_MIDDLE = 0x110, 0x111, 0x112
REL_X, REL_Y, REL_HWHEEL, REL_WHEEL = 0, 1, 6, 8

op = sys.argv[1]
arg = int(sys.argv[2]) if len(sys.argv) > 2 else 1
fd = os.open("/dev/uinput", os.O_WRONLY | os.O_NONBLOCK)
try:
    for bit in (EV_SYN, EV_KEY, EV_REL):
        fcntl.ioctl(fd, UI_SET_EVBIT, bit)
    for k in (BTN_LEFT, BTN_RIGHT, BTN_MIDDLE):
        fcntl.ioctl(fd, UI_SET_KEYBIT, k)
    for r in (REL_X, REL_Y, REL_HWHEEL, REL_WHEEL):
        fcntl.ioctl(fd, UI_SET_RELBIT, r)
    setup = struct.pack("=HHHH80sI", 0x03, 0x1234, 0x5678, 1, b"vibeforge-pointer", 0)
    fcntl.ioctl(fd, UI_DEV_SETUP, setup)
    fcntl.ioctl(fd, UI_DEV_CREATE)
    time.sleep(0.06)

    def emit(t, c, v):
        os.write(fd, struct.pack("=qqHHi", 0, 0, t, c, v))
    def syn():
        emit(EV_SYN, 0, 0)

    if op in ("click", "double-click", "right-click"):
        btn = BTN_RIGHT if op == "right-click" else BTN_LEFT
        count = 2 if op == "double-click" else 1
        for i in range(count):
            emit(EV_KEY, btn, 1); syn()
            time.sleep(0.025)
            emit(EV_KEY, btn, 0); syn()
            if i + 1 < count:
                time.sleep(0.06)
    elif op == "scroll-v":
        for _ in range(abs(arg)):
            emit(EV_REL, REL_WHEEL, 1 if arg > 0 else -1); syn()
            time.sleep(0.015)
    elif op == "scroll-h":
        for _ in range(abs(arg)):
            emit(EV_REL, REL_HWHEEL, 1 if arg > 0 else -1); syn()
            time.sleep(0.015)
finally:
    try:
        fcntl.ioctl(fd, UI_DEV_DESTROY)
    except OSError:
        pass
    os.close(fd)
`.trim();
