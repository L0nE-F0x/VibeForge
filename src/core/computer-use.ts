import { fuzzyMatchName } from "../shared/orchestrator-fuzzy.js";
import { validateKeyCombo, type ComputerActionKind, type ComputerSurface } from "../shared/computer-use.js";

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

/**
 * Builds an argv list (never a shell string) for `wtype`.
 */
export function buildWtypeArgs(mode: "type" | "key", value: string): string[] | null {
  if (mode === "type") {
    if (!value || value.length > 2000) return null;
    return ["--", value];
  }
  const combo = validateKeyCombo(value);
  if (!combo) return null;
  const args: string[] = [];
  for (const mod of combo.modifiers) args.push("-M", mod);
  args.push("-k", combo.key);
  for (const mod of [...combo.modifiers].reverse()) args.push("-m", mod);
  return args;
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
