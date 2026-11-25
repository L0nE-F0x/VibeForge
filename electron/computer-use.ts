import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { WebContents } from "electron";
import {
  appendComputerHint,
  buildDotoolInput,
  buildDotoolPointerInput,
  buildHyprDispatchArgs,
  buildHyprFallbackFocusSelector,
  buildHyprFocusSelector,
  buildWtypeArgs,
  buildYdotoolKeyArgs,
  formatComputerCommandError,
  hyprDispatchFailureReason,
  installHintFor,
  isHyprLuaDispatchError,
  matchDesktopWindow,
  parseHyprConfigProvider,
  parseHyprctlClients,
  parseHyprctlMonitors,
  parseHyprWorkspaceShortcut,
  screenshotToLogicalCoords,
  UINPUT_HELPER_SCRIPT,
  type ComputerActionRequest,
  type ComputerUseCapabilities,
  type ComputerUseDriver,
  type DesktopMonitorInfo,
  type DesktopWindowInfo,
  type HyprConfigProvider,
  type HyprDispatchCommand,
  type ScreenshotResult,
} from "../src/core/computer-use.js";
import { whichBin } from "../src/core/engines.js";
import { packageManagerOf, type PackageManager } from "../src/shared/computer.js";
import {
  describeComputerStep,
  parseComputerCoordinates,
  parseComputerDrag,
  parseComputerScroll,
  parseComputerWaitMs,
  validateKeyCombo,
  type ComputerSurface,
} from "../src/shared/computer-use.js";
import { parseOptions } from "../src/shared/orchestrator-actions.js";

const COMMAND_TIMEOUT_MS = 8000;
const MAX_CAPTURE_FILES = 24;

export interface WebContentsLike {
  capturePage(): Promise<{ isEmpty(): boolean; toPNG(): Buffer; getSize(): { width: number; height: number } }>;
  executeJavaScript<T = unknown>(code: string): Promise<T>;
  sendInputEvent: WebContents["sendInputEvent"];
  isDestroyed?: () => boolean;
}

export type ExecFileFn = (file: string, args: string[], opts?: { input?: string }) => Promise<{ stdout: string; stderr: string }>;

export interface ComputerDriverOptions {
  dataRoot: string;
  getAppWebContents: () => WebContentsLike | null;
  getBrowserWebContents: () => WebContentsLike | null;
  focusAppWindow?: () => void;
  resolveBin?: (bin: string) => string | null;
  execFileImpl?: ExecFileFn;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  uinputWritable?: () => boolean;
}

function errorDetails(err: unknown): string {
  if (!err || typeof err !== "object") return String(err ?? "");
  const rec = err as { message?: unknown; stdout?: unknown; stderr?: unknown };
  const parts = [rec.message, rec.stderr, rec.stdout].filter((v): v is string => typeof v === "string" && v.trim().length > 0);
  return [...new Set(parts)].join("\n") || String(err);
}

function missingToolError(action: string, detail: string, hint: string): Error {
  return new Error(`Desktop ${action} failed: ${detail}. ${hint}`);
}

function wrapExecError(file: string, args: readonly string[], err: unknown, hint?: string): Error {
  if (err && typeof err === "object") {
    const rec = err as {
      code?: number | string | null;
      signal?: string | null;
      killed?: boolean;
      stdout?: unknown;
      stderr?: unknown;
      message?: unknown;
    };
    const stdout = typeof rec.stdout === "string" ? rec.stdout : "";
    const stderr = typeof rec.stderr === "string" ? rec.stderr : "";
    const msg = typeof rec.message === "string" ? rec.message : String(err);
    if (msg.startsWith("Command failed") && (!stdout || msg.includes(stdout.trim())) && (!stderr || msg.includes(stderr.trim()))) {
      return new Error(appendComputerHint(msg, hint ?? ""));
    }
    return new Error(
      formatComputerCommandError({
        file,
        args,
        code: rec.code ?? null,
        signal: rec.signal ?? null,
        killed: rec.killed,
        stdout,
        stderr,
        message: msg,
        hint,
      }),
    );
  }
  return new Error(formatComputerCommandError({ file, args, message: String(err), hint }));
}

function defaultExecFile(file: string, args: string[], opts?: { input?: string }): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = execFile(file, args, { timeout: COMMAND_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024, encoding: "utf8" }, (err, stdout, stderr) => {
      const out = String(stdout ?? "");
      const errOut = String(stderr ?? "");
      if (err) {
        const execErr = err as Error & { code?: number | string | null; signal?: string | null; killed?: boolean };
        const rich = new Error(
          formatComputerCommandError({
            file,
            args,
            code: execErr.code ?? null,
            signal: execErr.signal ?? null,
            killed: execErr.killed,
            stdout: out,
            stderr: errOut,
            message: execErr.message,
          }),
        );
        Object.assign(rich, { code: execErr.code, stdout: out, stderr: errOut });
        reject(rich);
      } else {
        resolve({ stdout: out, stderr: errOut });
      }
    });
    if (opts?.input !== undefined && child.stdin) {
      child.stdin.on("error", () => {});
      child.stdin.write(opts.input);
      child.stdin.end();
    }
  });
}

function defaultUinputWritable(): boolean {
  try {
    fs.accessSync("/dev/uinput", fs.constants.R_OK | fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function capturePath(dataRoot: string): string {
  const dir = path.join(dataRoot, "orchestrator", "captures");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  try {
    const existing = fs
      .readdirSync(dir)
      .filter((name) => name.endsWith(".png"))
      .sort();
    while (existing.length >= MAX_CAPTURE_FILES) {
      const oldest = existing.shift();
      if (oldest) fs.rmSync(path.join(dir, oldest), { force: true });
    }
  } catch {
    /* ignore cleanup errors */
  }
  return path.join(dir, `cap-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.png`);
}

function saveCapturePng(dataRoot: string, png: Buffer): string {
  const outPath = capturePath(dataRoot);
  fs.writeFileSync(outPath, png, { mode: 0o600 });
  return outPath;
}

const DOM_SNAPSHOT_SCRIPT = `(() => {
  const vw = window.innerWidth || 0;
  const vh = window.innerHeight || 0;
  const nodes = Array.from(document.querySelectorAll('button, a[href], input, textarea, select, [role="button"], [role="tab"], [role="menuitem"]'));
  const items = [];
  for (const el of nodes) {
    const r = el.getBoundingClientRect();
    if (r.width < 4 || r.height < 4 || r.bottom < 0 || r.right < 0 || r.top > vh || r.left > vw) continue;
    const style = window.getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") continue;
    const label = (el.getAttribute("aria-label") || el.innerText || el.getAttribute("placeholder") || el.getAttribute("title") || el.tagName).replace(/\\s+/g, " ").trim().slice(0, 48);
    items.push({ tag: el.tagName.toLowerCase(), label, x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), w: Math.round(r.width), h: Math.round(r.height) });
    if (items.length >= 35) break;
  }
  return { title: document.title || "", url: location.href || "", vw, vh, items };
})()`;

interface DomSnapshot {
  title: string;
  url: string;
  vw: number;
  vh: number;
  items: Array<{ tag: string; label: string; x: number; y: number; w: number; h: number }>;
}

const ELECTRON_MODIFIER = {
  ctrl: "control",
  alt: "alt",
  shift: "shift",
  super: "meta",
} as const;

const ELECTRON_KEY_CODE: Record<string, string> = {
  Return: "Return",
  Escape: "Escape",
  Tab: "Tab",
  BackSpace: "Backspace",
  Delete: "Delete",
  space: "Space",
  Up: "Up",
  Down: "Down",
  Left: "Left",
  Right: "Right",
  Home: "Home",
  End: "End",
  Prior: "PageUp",
  Next: "PageDown",
  Insert: "Insert",
};

/**
 * Cross-platform controller for VibeForge's own Electron UI (`app`) and visible Browser Dock (`browser`).
 */
export class AppUiDriver {
  constructor(private readonly opts: ComputerDriverOptions) {}

  private targetContents(surface: "app" | "browser"): WebContentsLike {
    const wc = surface === "app" ? this.opts.getAppWebContents() : this.opts.getBrowserWebContents();
    if (!wc || wc.isDestroyed?.()) throw new Error("That view is not open right now.");
    return wc;
  }

  async screenshot(surface: "app" | "browser"): Promise<ScreenshotResult> {
    const wc = this.targetContents(surface);
    const img = await wc.capturePage();
    if (img.isEmpty()) throw new Error("That view is not open right now.");
    const png = img.toPNG();
    const size = img.getSize();
    const outPath = saveCapturePng(this.opts.dataRoot, png);
    const dom = (await wc.executeJavaScript<DomSnapshot>(DOM_SNAPSHOT_SCRIPT).catch(() => null)) ?? null;
    const lines = [`Surface: ${surface} (${size.width}x${size.height})`, `Saved screenshot: ${outPath}`];
    if (dom) {
      if (dom.title || dom.url) lines.push(`Page: ${dom.title || "(untitled)"}${dom.url && dom.url.startsWith("http") ? ` — ${dom.url}` : ""}`);
      if (dom.items.length) {
        lines.push("Visible interactive elements (center coordinates):");
        for (const item of dom.items) {
          lines.push(`- [${item.tag}] "${item.label}" at (${item.x}, ${item.y}) [${item.w}x${item.h}]`);
        }
      }
    }
    return {
      path: outPath,
      width: size.width,
      height: size.height,
      surface,
      summary: `Captured ${surface} (${size.width}x${size.height})`,
      details: lines.join("\n"),
    };
  }

  async act(req: ComputerActionRequest): Promise<string> {
    if (req.surface !== "app" && req.surface !== "browser") throw new Error("Unsupported action.");
    if (req.action === "screenshot") return (await this.screenshot(req.surface)).summary;
    if (req.action === "wait") {
      const ms = parseComputerWaitMs(req.prompt || req.target) ?? 500;
      await new Promise((resolve) => setTimeout(resolve, ms));
      return `Waited ${ms}ms.`;
    }
    const wc = this.targetContents(req.surface);
    if (req.surface === "app") this.opts.focusAppWindow?.();
    if (req.action === "move" || req.action === "click" || req.action === "double-click" || req.action === "right-click") {
      const coords = parseComputerCoordinates(req.target || req.prompt);
      if (!coords) throw new Error("Unsupported action.");
      wc.sendInputEvent({ type: "mouseMove", x: coords.x, y: coords.y });
      if (req.action !== "move") {
        const button = req.action === "right-click" ? "right" : "left";
        const clickCount = req.action === "double-click" ? 2 : 1;
        wc.sendInputEvent({ type: "mouseDown", x: coords.x, y: coords.y, button, clickCount });
        wc.sendInputEvent({ type: "mouseUp", x: coords.x, y: coords.y, button, clickCount });
      }
      return describeComputerStep(req);
    }
    if (req.action === "drag") {
      const drag = parseComputerDrag(req.target || req.prompt);
      if (!drag) throw new Error("Unsupported action.");
      wc.sendInputEvent({ type: "mouseMove", x: drag.fromX, y: drag.fromY });
      wc.sendInputEvent({ type: "mouseDown", x: drag.fromX, y: drag.fromY, button: "left", clickCount: 1 });
      wc.sendInputEvent({ type: "mouseMove", x: drag.toX, y: drag.toY, button: "left" });
      wc.sendInputEvent({ type: "mouseUp", x: drag.toX, y: drag.toY, button: "left", clickCount: 1 });
      return describeComputerStep(req);
    }
    if (req.action === "scroll") {
      const scroll = parseComputerScroll(req.prompt || req.target);
      if (!scroll) throw new Error("Unsupported action.");
      const coords = parseComputerCoordinates(req.target) ?? { x: 200, y: 200 };
      const px = scroll.amount * 80;
      const deltaY = scroll.direction === "up" ? px : scroll.direction === "down" ? -px : 0;
      const deltaX = scroll.direction === "left" ? px : scroll.direction === "right" ? -px : 0;
      wc.sendInputEvent({ type: "mouseWheel", x: coords.x, y: coords.y, deltaX, deltaY });
      return describeComputerStep(req);
    }
    if (req.action === "type") {
      if (!req.prompt) throw new Error("Unsupported action.");
      for (const ch of req.prompt) {
        if (ch === "\n" || ch === "\r") {
          wc.sendInputEvent({ type: "keyDown", keyCode: "Return" });
          wc.sendInputEvent({ type: "keyUp", keyCode: "Return" });
        } else {
          wc.sendInputEvent({ type: "char", keyCode: ch });
        }
      }
      return describeComputerStep(req);
    }
    if (req.action === "key") {
      const combo = validateKeyCombo(req.prompt || req.target);
      if (!combo) throw new Error("Unsupported action.");
      const keyCode = ELECTRON_KEY_CODE[combo.key] ?? combo.key;
      const modifiers = combo.modifiers.map((m) => ELECTRON_MODIFIER[m]);
      wc.sendInputEvent({ type: "keyDown", keyCode, modifiers });
      wc.sendInputEvent({ type: "keyUp", keyCode, modifiers });
      return describeComputerStep(req);
    }
    throw new Error("Unsupported action.");
  }
}

/**
 * Hyprland (Wayland/Omarchy) desktop driver using `hyprctl` (hyprlang and 0.56+ Lua dispatch),
 * `grim`, optional `tesseract`, `wtype`/`ydotool`/`dotool`, and `/dev/uinput`.
 */
export class HyprlandWaylandDriver implements ComputerUseDriver {
  private readonly appUi: AppUiDriver;
  private readonly exec: ExecFileFn;
  private readonly bin: (name: string) => string | null;
  private readonly uinputOk: () => boolean;
  private hyprMode: HyprConfigProvider | null = null;

  constructor(private readonly opts: ComputerDriverOptions) {
    this.appUi = new AppUiDriver(opts);
    this.exec = opts.execFileImpl ?? defaultExecFile;
    this.bin = opts.resolveBin ?? whichBin;
    this.uinputOk = opts.uinputWritable ?? defaultUinputWritable;
  }

  private pkgMgr(): PackageManager | null {
    return packageManagerOf((bin) => Boolean(this.bin(bin)));
  }

  private async detectHyprMode(hyprctl: string): Promise<HyprConfigProvider> {
    if (this.hyprMode) return this.hyprMode;
    const res = await this.exec(hyprctl, ["status"]).catch(() => ({ stdout: "", stderr: "" }));
    this.hyprMode = parseHyprConfigProvider(res.stdout);
    return this.hyprMode;
  }

  private async hyprDispatch(hyprctl: string, cmd: HyprDispatchCommand): Promise<void> {
    const runMode = async (mode: HyprConfigProvider) => {
      const args = buildHyprDispatchArgs(mode, cmd);
      const res = await this.exec(hyprctl, args);
      const failure = hyprDispatchFailureReason(res.stdout, res.stderr);
      if (failure) {
        throw new Error(formatComputerCommandError({ file: hyprctl, args, stdout: res.stdout, stderr: res.stderr }));
      }
    };
    const mode = await this.detectHyprMode(hyprctl);
    try {
      await runMode(mode);
    } catch (err) {
      const details = errorDetails(err);
      if (mode === "hyprlang" && isHyprLuaDispatchError(details)) {
        this.hyprMode = "lua";
        const luaArgs = buildHyprDispatchArgs("lua", cmd);
        try {
          await runMode("lua");
          return;
        } catch (retryErr) {
          throw wrapExecError(hyprctl, luaArgs, retryErr);
        }
      }
      throw wrapExecError(hyprctl, buildHyprDispatchArgs(mode, cmd), err);
    }
  }

  private async listMonitors(hyprctl: string | null): Promise<DesktopMonitorInfo[]> {
    if (!hyprctl) return [];
    const { stdout } = await this.exec(hyprctl, ["-j", "monitors"]).catch(() => ({ stdout: "[]", stderr: "" }));
    return parseHyprctlMonitors(stdout);
  }

  private async activeMonitor(hyprctl: string | null): Promise<DesktopMonitorInfo | null> {
    const monitors = await this.listMonitors(hyprctl);
    return monitors.find((m) => m.focused) ?? monitors[0] ?? null;
  }

  private async toLogicalCoords(
    hyprctl: string | null,
    coords: { x: number; y: number },
    options?: string,
    monOverride?: DesktopMonitorInfo | null,
  ): Promise<{ x: number; y: number }> {
    if (parseOptions(options).str("coords")?.toLowerCase() === "logical") {
      return { x: Math.round(coords.x), y: Math.round(coords.y) };
    }
    const mon = monOverride !== undefined ? monOverride : await this.activeMonitor(hyprctl);
    return screenshotToLogicalCoords(coords, mon);
  }

  async capabilities(): Promise<ComputerUseCapabilities> {
    const hasHypr = Boolean(this.bin("hyprctl"));
    const hasGrim = Boolean(this.bin("grim"));
    const hasPointer = hasHypr && ((Boolean(this.bin("python3")) && this.uinputOk()) || Boolean(this.bin("ydotool")) || Boolean(this.bin("dotool")));
    const hasKeyboard = Boolean(this.bin("wtype")) || Boolean(this.bin("ydotool")) || Boolean(this.bin("dotool"));
    return {
      platform: this.opts.platform ?? process.platform,
      sessionType: "wayland",
      compositor: "hyprland",
      canScreenshot: hasGrim,
      canListWindows: hasHypr,
      canPointer: hasPointer,
      canKeyboard: hasKeyboard,
      canAppUi: Boolean(this.opts.getAppWebContents()),
    };
  }

  async listWindows(): Promise<DesktopWindowInfo[]> {
    const hyprctl = this.bin("hyprctl");
    if (!hyprctl) return [];
    const { stdout } = await this.exec(hyprctl, ["-j", "clients"]).catch(() => ({ stdout: "[]", stderr: "" }));
    return parseHyprctlClients(stdout);
  }

  async screenshot(opts: { surface?: ComputerSurface; target?: string } = {}): Promise<ScreenshotResult> {
    const surface = opts.surface ?? "desktop";
    if (surface === "app" || surface === "browser") return this.appUi.screenshot(surface);
    const grim = this.bin("grim");
    const hyprctl = this.bin("hyprctl");
    if (!grim) throw missingToolError("screenshot", 'missing binary "grim"', installHintFor(["grim"], this.pkgMgr()));
    const outPath = capturePath(this.opts.dataRoot);
    const [windows, monitors] = await Promise.all([this.listWindows(), this.listMonitors(hyprctl)]);
    const activeMon = monitors.find((m) => m.focused) ?? monitors[0] ?? null;
    const targetWin = opts.target ? matchDesktopWindow(opts.target, windows) : null;
    const args: string[] = [];
    if (targetWin && targetWin.size[0] > 0 && targetWin.size[1] > 0) {
      args.push("-g", `${targetWin.at[0]},${targetWin.at[1]} ${targetWin.size[0]}x${targetWin.size[1]}`);
    } else if (monitors.length > 1 && activeMon) {
      args.push("-o", activeMon.name);
    }
    args.push(outPath);
    try {
      await this.exec(grim, args);
    } catch (err) {
      throw wrapExecError(grim, args, err);
    }
    try {
      fs.chmodSync(outPath, 0o600);
    } catch {
      /* ignore missing file in tests */
    }
    const tess = this.bin("tesseract");
    let ocrText = "";
    if (tess && fs.existsSync(outPath)) {
      const ocr = await this.exec(tess, [outPath, "stdout", "--oem", "1", "-l", "eng"]).catch(() => ({ stdout: "", stderr: "" }));
      ocrText = ocr.stdout.trim().slice(0, 1200);
    }
    const scale = activeMon?.scale ?? 1;
    const details = [
      `Surface: desktop (Hyprland${targetWin ? ` — window "${targetWin.title}" [${targetWin.class}]` : ""})`,
      ...(monitors.length
        ? [
            `Monitors: ${monitors
              .map(
                (m) =>
                  `${m.name} (${m.width}x${m.height} px / ${Math.round(m.width / m.scale)}x${Math.round(m.height / m.scale)} logical @ ${m.x},${m.y}, scale ${m.scale}${m.focused ? ", focused" : ""})`,
              )
              .join("; ")}`,
          ]
        : []),
      ...(activeMon && scale !== 1
        ? [
            `Coordinate scaling: screenshot is ${activeMon.width}x${activeMon.height} (scale ${scale}); desktop click/move/drag/scroll coordinates are automatically converted to Hyprland logical space (${Math.round(activeMon.width / scale)}x${Math.round(activeMon.height / scale)}).`,
          ]
        : []),
      ...(windows.length
        ? ["Open windows:", ...windows.slice(0, 15).map((w) => `- "${w.title || w.class}" [${w.class}] ws=${w.workspace} at (${w.at[0]},${w.at[1]}) size ${w.size[0]}x${w.size[1]}${w.focused ? " [focused]" : ""}`)]
        : []),
      `Saved screenshot: ${outPath}`,
      ...(ocrText ? [`OCR text snippet:\n${ocrText}`] : []),
    ].join("\n");
    return {
      path: outPath,
      width: targetWin ? Math.round(targetWin.size[0] * scale) : activeMon?.width,
      height: targetWin ? Math.round(targetWin.size[1] * scale) : activeMon?.height,
      surface: "desktop",
      summary: targetWin ? `Captured window "${targetWin.title}"` : `Captured desktop screen (${windows.length} window${windows.length === 1 ? "" : "s"})`,
      details,
    };
  }

  private async pointerOp(op: "click" | "double-click" | "right-click" | "scroll-v" | "scroll-h", arg?: number): Promise<void> {
    const py = this.bin("python3");
    const uinputReady = Boolean(py && this.uinputOk());
    const ydo = this.bin("ydotool");
    const dotool = this.bin("dotool");

    if (!uinputReady && !ydo && !dotool) {
      const reasons: string[] = [];
      if (!py) reasons.push('missing binary "python3"');
      else if (!this.uinputOk()) reasons.push("/dev/uinput is not writable");
      reasons.push('missing binaries "ydotool" and "dotool"');
      const hint = `${installHintFor(["ydotool"], this.pkgMgr())} (or grant /dev/uinput access / install dotool).`;
      throw missingToolError("pointer control", reasons.join("; "), hint);
    }

    const failures: string[] = [];
    if (py && uinputReady) {
      const pyArgs = ["-I", "-c", UINPUT_HELPER_SCRIPT, op, ...(arg !== undefined ? [String(arg)] : [])];
      try {
        await this.exec(py, pyArgs);
        return;
      } catch (err) {
        failures.push(wrapExecError(py, pyArgs, err).message);
      }
    }

    if (ydo) {
      let lastArgs: string[] = ["click", "0xC0"];
      try {
        if (op === "click") {
          lastArgs = ["click", "0xC0"];
          await this.exec(ydo, lastArgs);
        } else if (op === "double-click") {
          lastArgs = ["click", "0xC0"];
          await this.exec(ydo, lastArgs);
          await this.exec(ydo, lastArgs);
        } else if (op === "right-click") {
          lastArgs = ["click", "0xC1"];
          await this.exec(ydo, lastArgs);
        } else if (op === "scroll-v" && arg !== undefined) {
          lastArgs = ["mousemove", "-w", "--", "0", String(-arg)];
          await this.exec(ydo, lastArgs);
        } else if (op === "scroll-h" && arg !== undefined) {
          lastArgs = ["mousemove", "-w", "--", String(arg), "0"];
          await this.exec(ydo, lastArgs);
        }
        return;
      } catch (err) {
        failures.push(wrapExecError(ydo, lastArgs, err).message);
      }
    }

    if (dotool) {
      try {
        await this.exec(dotool, [], { input: buildDotoolPointerInput(op, arg) });
        return;
      } catch (err) {
        failures.push(wrapExecError(dotool, [], err).message);
      }
    }

    const fallbackHint = !ydo ? `${installHintFor(["ydotool"], this.pkgMgr())} or install dotool as a fallback.` : !dotool ? "Install dotool or grant /dev/uinput access." : "Ensure ydotoold is running or /dev/uinput is writable.";
    throw new Error(appendComputerHint(failures.join("\n"), fallbackHint));
  }

  private async keyboardOp(action: "type" | "key", value: string): Promise<void> {
    if (action === "type") {
      if (!value || value.length > 2000) throw new Error("Unsupported action.");
    } else if (!validateKeyCombo(value)) {
      throw new Error("Unsupported action.");
    }

    const wtype = this.bin("wtype");
    const ydo = this.bin("ydotool");
    const dotool = this.bin("dotool");
    if (!wtype && !ydo && !dotool) {
      throw missingToolError("keyboard input", "missing binary (checked wtype, ydotool, dotool)", installHintFor(["wtype"], this.pkgMgr()));
    }

    const failures: string[] = [];
    if (wtype) {
      const args = buildWtypeArgs(action, value);
      if (!args) throw new Error("Unsupported action.");
      try {
        await this.exec(wtype, args);
        return;
      } catch (err) {
        failures.push(wrapExecError(wtype, args, err).message);
      }
    }

    if (ydo) {
      const args = buildYdotoolKeyArgs(action, value);
      if (args) {
        try {
          await this.exec(ydo, args);
          return;
        } catch (err) {
          failures.push(wrapExecError(ydo, args, err).message);
        }
      }
    }

    if (dotool) {
      const input = buildDotoolInput(action, value);
      if (input) {
        try {
          await this.exec(dotool, [], { input });
          return;
        } catch (err) {
          failures.push(wrapExecError(dotool, [], err).message);
        }
      }
    }

    const missingAlt = !ydo ? "ydotool" : !dotool ? "dotool" : "wtype";
    const altHint = installHintFor([missingAlt], this.pkgMgr());
    throw new Error(appendComputerHint(failures.join("\n"), altHint));
  }

  async act(req: ComputerActionRequest): Promise<string> {
    if (req.surface === "app" || req.surface === "browser") return this.appUi.act(req);
    if (req.action === "screenshot") return (await this.screenshot({ surface: "desktop", target: req.target })).summary;
    if (req.action === "windows") {
      const wins = await this.listWindows();
      return `${wins.length} window${wins.length === 1 ? "" : "s"} open.`;
    }
    if (req.action === "wait") {
      const ms = parseComputerWaitMs(req.prompt || req.target) ?? 500;
      await new Promise((resolve) => setTimeout(resolve, ms));
      return `Waited ${ms}ms.`;
    }
    const hyprctl = this.bin("hyprctl");
    if (req.action === "focus-window") {
      if (!hyprctl) throw missingToolError("window focus", 'missing binary "hyprctl"', "Install Hyprland or run inside a Hyprland session.");
      const windows = await this.listWindows();
      const win = matchDesktopWindow(req.target || req.prompt, windows);
      if (!win) throw new Error("No open window matched that name.");
      const selector = buildHyprFocusSelector(win);
      if (!selector) throw new Error("No open window matched that name.");
      try {
        await this.hyprDispatch(hyprctl, { kind: "focuswindow", selector });
      } catch (err) {
        const fallback = selector.startsWith("address:") ? buildHyprFallbackFocusSelector(win) : null;
        if (fallback && /window not found|no such window|not found/i.test(errorDetails(err))) {
          await this.hyprDispatch(hyprctl, { kind: "focuswindow", selector: fallback });
        } else {
          throw err;
        }
      }
      return `Focused "${win.title || win.class}".`;
    }
    if (req.action === "move" || req.action === "click" || req.action === "double-click" || req.action === "right-click") {
      if (!hyprctl) throw missingToolError("pointer control", 'missing binary "hyprctl"', "Install Hyprland or run inside a Hyprland session.");
      const coords = parseComputerCoordinates(req.target || req.prompt);
      if (!coords) throw new Error("Unsupported action.");
      const logical = await this.toLogicalCoords(hyprctl, coords, req.options);
      await this.hyprDispatch(hyprctl, { kind: "movecursor", x: logical.x, y: logical.y });
      if (req.action !== "move") await this.pointerOp(req.action);
      return describeComputerStep(req);
    }
    if (req.action === "scroll") {
      const scroll = parseComputerScroll(req.prompt || req.target);
      if (!scroll) throw new Error("Unsupported action.");
      const coords = parseComputerCoordinates(req.target);
      if (coords && hyprctl) {
        const logical = await this.toLogicalCoords(hyprctl, coords, req.options);
        await this.hyprDispatch(hyprctl, { kind: "movecursor", x: logical.x, y: logical.y });
      }
      const signed = scroll.direction === "up" || scroll.direction === "right" ? scroll.amount : -scroll.amount;
      await this.pointerOp(scroll.direction === "left" || scroll.direction === "right" ? "scroll-h" : "scroll-v", signed);
      return describeComputerStep(req);
    }
    if (req.action === "drag") {
      const drag = parseComputerDrag(req.target || req.prompt);
      if (!drag) throw new Error("Unsupported action.");
      if (!hyprctl) throw missingToolError("drag", 'missing binary "hyprctl"', "Install Hyprland or run inside a Hyprland session.");
      const ydo = this.bin("ydotool");
      const dotool = this.bin("dotool");
      if (!ydo && !dotool) {
        throw missingToolError("drag", 'missing binary "ydotool" or "dotool"', installHintFor(["ydotool"], this.pkgMgr()));
      }
      const mon = await this.activeMonitor(hyprctl);
      const from = await this.toLogicalCoords(hyprctl, { x: drag.fromX, y: drag.fromY }, req.options, mon);
      const to = await this.toLogicalCoords(hyprctl, { x: drag.toX, y: drag.toY }, req.options, mon);
      const failures: string[] = [];
      if (ydo) {
        try {
          await this.hyprDispatch(hyprctl, { kind: "movecursor", x: from.x, y: from.y });
          await this.exec(ydo, ["click", "0x40"]);
          await this.hyprDispatch(hyprctl, { kind: "movecursor", x: to.x, y: to.y });
          await this.exec(ydo, ["click", "0x80"]);
          return describeComputerStep(req);
        } catch (err) {
          failures.push(wrapExecError(ydo, ["click", "0x40/0x80"], err).message);
        }
      }
      if (dotool) {
        try {
          await this.hyprDispatch(hyprctl, { kind: "movecursor", x: from.x, y: from.y });
          await this.exec(dotool, [], { input: "buttondown left\n" });
          await this.hyprDispatch(hyprctl, { kind: "movecursor", x: to.x, y: to.y });
          await this.exec(dotool, [], { input: "buttonup left\n" });
          return describeComputerStep(req);
        } catch (err) {
          failures.push(wrapExecError(dotool, [], err).message);
        }
      }
      const dragHint = installHintFor([!dotool ? "dotool" : "ydotool"], this.pkgMgr());
      throw new Error(appendComputerHint(failures.join("\n"), dragHint));
    }
    if (req.action === "type" || req.action === "key") {
      if (req.action === "key") {
        const ws = parseHyprWorkspaceShortcut(req.prompt || req.target);
        if (ws && hyprctl) {
          await this.hyprDispatch(hyprctl, { kind: "workspace", workspace: ws });
          return `Switched to workspace ${ws}.`;
        }
      }
      const value = req.action === "type" ? req.prompt : req.prompt || req.target;
      await this.keyboardOp(req.action, value);
      return describeComputerStep(req);
    }
    throw new Error("Unsupported action.");
  }
}

/**
 * X11 fallback driver when `DISPLAY` is active without Wayland (uses `import`/`scrot` + `xdotool`).
 */
export class X11Driver implements ComputerUseDriver {
  private readonly appUi: AppUiDriver;
  private readonly exec: ExecFileFn;
  private readonly bin: (name: string) => string | null;

  constructor(private readonly opts: ComputerDriverOptions) {
    this.appUi = new AppUiDriver(opts);
    this.exec = opts.execFileImpl ?? defaultExecFile;
    this.bin = opts.resolveBin ?? whichBin;
  }

  async capabilities(): Promise<ComputerUseCapabilities> {
    return {
      platform: this.opts.platform ?? process.platform,
      sessionType: "x11",
      compositor: "x11",
      canScreenshot: Boolean(this.bin("import") || this.bin("scrot")),
      canListWindows: Boolean(this.bin("xdotool")),
      canPointer: Boolean(this.bin("xdotool")),
      canKeyboard: Boolean(this.bin("xdotool")),
      canAppUi: Boolean(this.opts.getAppWebContents()),
    };
  }

  async listWindows(): Promise<DesktopWindowInfo[]> {
    const xdo = this.bin("xdotool");
    if (!xdo) return [];
    const { stdout } = await this.exec(xdo, ["search", "--onlyvisible", "--name", ".*"]).catch(() => ({ stdout: "", stderr: "" }));
    const ids = stdout.split(/\r?\n/).filter(Boolean).slice(0, 15);
    const wins: DesktopWindowInfo[] = [];
    for (const id of ids) {
      const title = await this.exec(xdo, ["getwindowname", id]).then((r) => r.stdout.trim()).catch(() => "");
      wins.push({ address: id, class: "x11", title, workspace: "0", at: [0, 0], size: [0, 0], focused: false });
    }
    return wins;
  }

  async screenshot(opts: { surface?: ComputerSurface; target?: string } = {}): Promise<ScreenshotResult> {
    const surface = opts.surface ?? "desktop";
    if (surface === "app" || surface === "browser") return this.appUi.screenshot(surface);
    const outPath = capturePath(this.opts.dataRoot);
    const imp = this.bin("import");
    const scrot = this.bin("scrot");
    const pkgMgr = packageManagerOf((b) => Boolean(this.bin(b)));
    if (imp) await this.exec(imp, ["-window", "root", outPath]);
    else if (scrot) await this.exec(scrot, [outPath]);
    else throw missingToolError("screenshot", 'missing binary "import" or "scrot"', installHintFor(["scrot"], pkgMgr));
    const wins = await this.listWindows();
    return {
      path: outPath,
      surface: "desktop",
      summary: `Captured X11 desktop (${wins.length} window${wins.length === 1 ? "" : "s"})`,
      details: `Surface: desktop (X11)\nSaved screenshot: ${outPath}`,
    };
  }

  async act(req: ComputerActionRequest): Promise<string> {
    if (req.surface === "app" || req.surface === "browser") return this.appUi.act(req);
    if (req.action === "screenshot") return (await this.screenshot({ surface: "desktop" })).summary;
    if (req.action === "windows") {
      const wins = await this.listWindows();
      return `${wins.length} window${wins.length === 1 ? "" : "s"} open.`;
    }
    if (req.action === "wait") {
      const ms = parseComputerWaitMs(req.prompt || req.target) ?? 500;
      await new Promise((resolve) => setTimeout(resolve, ms));
      return `Waited ${ms}ms.`;
    }
    const xdo = this.bin("xdotool");
    if (!xdo) {
      const pkgMgr = packageManagerOf((b) => Boolean(this.bin(b)));
      throw missingToolError("computer control", 'missing binary "xdotool"', installHintFor(["xdotool"], pkgMgr));
    }
    if (req.action === "focus-window") {
      const wins = await this.listWindows();
      const win = matchDesktopWindow(req.target || req.prompt, wins);
      if (!win) throw new Error("No open window matched that name.");
      await this.exec(xdo, ["windowactivate", win.address]);
      return `Focused "${win.title}".`;
    }
    if (req.action === "move" || req.action === "click" || req.action === "double-click" || req.action === "right-click") {
      const coords = parseComputerCoordinates(req.target || req.prompt);
      if (!coords) throw new Error("Unsupported action.");
      await this.exec(xdo, ["mousemove", "--sync", String(coords.x), String(coords.y)]);
      if (req.action === "click") await this.exec(xdo, ["click", "1"]);
      else if (req.action === "double-click") await this.exec(xdo, ["click", "--repeat", "2", "1"]);
      else if (req.action === "right-click") await this.exec(xdo, ["click", "3"]);
      return describeComputerStep(req);
    }
    if (req.action === "scroll") {
      const scroll = parseComputerScroll(req.prompt || req.target);
      if (!scroll) throw new Error("Unsupported action.");
      const coords = parseComputerCoordinates(req.target);
      if (coords) await this.exec(xdo, ["mousemove", "--sync", String(coords.x), String(coords.y)]);
      // X's wheel is buttons 4 (up), 5 (down), 6 (left) and 7 (right).
      const button = { up: "4", down: "5", left: "6", right: "7" }[scroll.direction];
      await this.exec(xdo, ["click", "--repeat", String(scroll.amount), button]);
      return describeComputerStep(req);
    }
    if (req.action === "drag") {
      const drag = parseComputerDrag(req.target || req.prompt);
      if (!drag) throw new Error("Unsupported action.");
      await this.exec(xdo, ["mousemove", "--sync", String(drag.fromX), String(drag.fromY)]);
      await this.exec(xdo, ["mousedown", "1"]);
      await this.exec(xdo, ["mousemove", "--sync", String(drag.toX), String(drag.toY)]);
      await this.exec(xdo, ["mouseup", "1"]);
      return describeComputerStep(req);
    }
    if (req.action === "type") {
      await this.exec(xdo, ["type", "--clearmodifiers", "--", req.prompt]);
      return describeComputerStep(req);
    }
    if (req.action === "key") {
      const combo = validateKeyCombo(req.prompt || req.target);
      if (!combo) throw new Error("Unsupported action.");
      const spec = [...combo.modifiers, combo.key].join("+");
      await this.exec(xdo, ["key", "--clearmodifiers", spec]);
      return describeComputerStep(req);
    }
    throw new Error("Desktop computer control is not available on this display session.");
  }
}

/**
 * Fallback driver when desktop automation tools are unsupported (e.g. non-X11/Hyprland sessions);
 * still supports inspecting and driving VibeForge's own UI and Browser Dock.
 */
export class UnsupportedPlatformDriver implements ComputerUseDriver {
  private readonly appUi: AppUiDriver;
  constructor(private readonly opts: ComputerDriverOptions) {
    this.appUi = new AppUiDriver(opts);
  }

  async capabilities(): Promise<ComputerUseCapabilities> {
    return {
      platform: this.opts.platform ?? process.platform,
      sessionType: "other",
      compositor: "none",
      canScreenshot: Boolean(this.opts.getAppWebContents()),
      canListWindows: false,
      canPointer: false,
      canKeyboard: false,
      canAppUi: Boolean(this.opts.getAppWebContents()),
    };
  }

  async listWindows(): Promise<DesktopWindowInfo[]> {
    return [];
  }

  async screenshot(opts: { surface?: ComputerSurface } = {}): Promise<ScreenshotResult> {
    if (opts.surface === "app" || opts.surface === "browser") return this.appUi.screenshot(opts.surface);
    throw new Error("Desktop computer control is not available on this display session.");
  }

  async act(req: ComputerActionRequest): Promise<string> {
    if (req.surface === "app" || req.surface === "browser") return this.appUi.act(req);
    throw new Error("Desktop computer control is not available on this display session.");
  }
}

export function createComputerUseDriver(opts: ComputerDriverOptions): ComputerUseDriver {
  const env = opts.env ?? process.env;
  const plat = opts.platform ?? process.platform;
  if (plat === "linux" && env.HYPRLAND_INSTANCE_SIGNATURE && env.WAYLAND_DISPLAY) {
    return new HyprlandWaylandDriver(opts);
  }
  if (plat === "linux" && env.DISPLAY && !env.WAYLAND_DISPLAY) {
    return new X11Driver(opts);
  }
  return new UnsupportedPlatformDriver(opts);
}
