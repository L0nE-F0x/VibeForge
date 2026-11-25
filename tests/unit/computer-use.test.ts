import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  createComputerUseDriver,
  HyprlandWaylandDriver,
  UnsupportedPlatformDriver,
  X11Driver,
  type WebContentsLike,
} from "../../electron/computer-use.js";
import { buildWtypeArgs, matchDesktopWindow, parseHyprctlClients, parseHyprctlMonitors } from "../../src/core/computer-use.js";
import {
  computerStepIssue,
  describeComputerStep,
  holdsForGo,
  isReadOnlyComputerAction,
  normalizeComputerAction,
  parseComputerCoordinates,
  parseComputerDrag,
  parseComputerScroll,
  parseComputerSurface,
  parseComputerWaitMs,
  resolvePlan,
  safeInCall,
  validateKeyCombo,
  type PlanContext,
} from "../../src/core/orchestrator.js";
import { setup, tempDir } from "./fixtures/service-harness.js";

const ok = (stdout: string) => ({ code: 0, stdout, stderr: "", timedOut: false });

function setupWithClaude() {
  const ctx = setup();
  const file = path.join(ctx.configRoot, "engines.json");
  const engines = JSON.parse(fs.readFileSync(file, "utf8")) as { engines: unknown[] };
  engines.engines.push({ id: "claude", label: "Claude Code", bin: "argy", args: [] });
  fs.writeFileSync(file, JSON.stringify(engines));
  ctx.svc.saveSettings({ orchestrator: { engine: "claude", mode: "go", model: "", projectsFolder: "" } });
  return ctx;
}

describe("Computer-use shared parsers and validation", () => {
  it("normalizes actions, surfaces, coordinates, drags, scrolls, waits, and key combos safely", () => {
    expect(normalizeComputerAction("capture")).toBe("screenshot");
    expect(normalizeComputerAction("open_windows")).toBe("windows");
    expect(normalizeComputerAction("focus")).toBe("focus-window");
    expect(normalizeComputerAction("left-click")).toBe("click");
    expect(normalizeComputerAction("dblclick")).toBe("double-click");
    expect(normalizeComputerAction("right_click")).toBe("right-click");
    expect(normalizeComputerAction("hotkey")).toBe("key");
    expect(normalizeComputerAction("unknown_action")).toBeNull();

    expect(isReadOnlyComputerAction("screenshot")).toBe(true);
    expect(isReadOnlyComputerAction("windows")).toBe(true);
    expect(isReadOnlyComputerAction("click")).toBe(false);
    expect(isReadOnlyComputerAction("type")).toBe(false);

    expect(parseComputerSurface("surface=app", "desktop")).toBe("app");
    expect(parseComputerSurface("surface=browser", "")).toBe("browser");
    expect(parseComputerSurface("", "browser-dock")).toBe("browser");
    expect(parseComputerSurface("", "VibeForge")).toBe("app");
    expect(parseComputerSurface("", "Firefox")).toBe("desktop");

    expect(parseComputerCoordinates("540, 320")).toEqual({ x: 540, y: 320 });
    expect(parseComputerCoordinates("x=120 y=450")).toEqual({ x: 120, y: 450 });
    expect(parseComputerCoordinates("-5, 20")).toBeNull();
    expect(parseComputerCoordinates("99999, 20")).toBeNull();

    expect(parseComputerDrag("100,200 -> 400,500")).toEqual({ fromX: 100, fromY: 200, toX: 400, toY: 500 });
    expect(parseComputerDrag("bad")).toBeNull();

    expect(parseComputerScroll("down 5")).toEqual({ direction: "down", amount: 5 });
    expect(parseComputerScroll("up 99")).toEqual({ direction: "up", amount: 20 });
    expect(parseComputerScroll("diagonal")).toBeNull();

    expect(validateKeyCombo("Ctrl+L")).toEqual({ modifiers: ["ctrl"], key: "l" });
    expect(validateKeyCombo("Super+Shift+Return")).toEqual({ modifiers: ["super", "shift"], key: "Return" });
    // Rejects arbitrary shell payloads or unsafe strings
    expect(validateKeyCombo("Ctrl+L; rm -rf /")).toBeNull();
    expect(validateKeyCombo("$(whoami)")).toBeNull();

    expect(parseComputerWaitMs("750ms")).toBe(750);
    expect(parseComputerWaitMs("2s")).toBe(2000);
    expect(parseComputerWaitMs("30s")).toBeNull();

    expect(computerStepIssue({ action: "click", target: "100,200" })).toBeNull();
    expect(computerStepIssue({ action: "click", target: "missing" })).toBe("target");
    expect(computerStepIssue({ action: "drag", target: "10,10 -> 50,50" })).toBeNull();
    expect(computerStepIssue({ action: "drag", target: "oops" })).toBe("target");
    expect(computerStepIssue({ action: "scroll", prompt: "down 3" })).toBeNull();
    expect(computerStepIssue({ action: "focus-window", target: "Firefox" })).toBeNull();
    expect(computerStepIssue({ action: "focus-window", target: "" })).toBe("target");
    expect(computerStepIssue({ action: "type", prompt: "hello" })).toBeNull();
    expect(computerStepIssue({ action: "type", prompt: "" })).toBe("prompt");
    expect(computerStepIssue({ action: "key", prompt: "Ctrl+C" })).toBeNull();
    expect(computerStepIssue({ action: "key", prompt: "`bad`" })).toBe("prompt");

    expect(describeComputerStep({ action: "click", target: "10,20", options: "surface=app" })).toBe("Click (10, 20) · app");
    expect(describeComputerStep({ action: "focus-window", target: "Firefox" })).toBe("Focus window Firefox");
    expect(describeComputerStep({ action: "type", prompt: "hello world", options: "surface=browser" })).toBe('Type "hello world" · browser');
  });

  it("parses hyprctl JSON, fuzzy-matches windows, and builds non-shell wtype argv", () => {
    const monitors = parseHyprctlMonitors(JSON.stringify([{ name: "DP-1", width: 2560, height: 1440, x: 0, y: 0, scale: 1.5, focused: true }]));
    expect(monitors).toEqual([{ name: "DP-1", width: 2560, height: 1440, x: 0, y: 0, scale: 1.5, focused: true }]);
    expect(parseHyprctlMonitors("not json")).toEqual([]);

    const clients = parseHyprctlClients(
      JSON.stringify([
        { address: "0xaaa", class: "firefox", title: "VibeForge Docs — Mozilla Firefox", workspace: { name: "2" }, at: [100, 120], size: [1200, 900], focusHistoryID: 0, mapped: true },
        { address: "0xbbb", class: "kitty", title: "Terminal", workspace: { name: "1" }, at: [0, 0], size: [800, 600], focusHistoryID: 1, mapped: true },
        { address: "0xccc", class: "hidden", title: "Unmapped", mapped: false },
      ]),
    );
    expect(clients).toHaveLength(2);
    expect(matchDesktopWindow("Firefox", clients)?.address).toBe("0xaaa");
    expect(matchDesktopWindow("firefx", clients)?.address).toBe("0xaaa");
    expect(matchDesktopWindow("0xbbb", clients)?.address).toBe("0xbbb");

    expect(buildWtypeArgs("type", "hello; rm -rf /")).toEqual(["--", "hello; rm -rf /"]);
    expect(buildWtypeArgs("key", "Ctrl+Shift+T")).toEqual(["-M", "ctrl", "-M", "shift", "-k", "t", "-m", "shift", "-m", "ctrl"]);
    expect(buildWtypeArgs("key", "invalid;key")).toBeNull();
  });
});

describe("Computer-use Electron drivers (Hyprland, X11, AppUI, Fallback)", () => {
  const pngStub = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  function fakeWebContents(): { wc: WebContentsLike; events: Array<{ type?: string; x?: number; y?: number; keyCode?: string }> } {
    const events: Array<{ type?: string; x?: number; y?: number; keyCode?: string }> = [];
    const wc: WebContentsLike = {
      capturePage: async () => ({ isEmpty: () => false, toPNG: () => pngStub, getSize: () => ({ width: 800, height: 600 }) }),
      executeJavaScript: async () =>
        ({
          title: "VibeForge",
          url: "http://localhost:5173",
          vw: 800,
          vh: 600,
          items: [{ tag: "button", label: "Go", x: 120, y: 40, w: 44, h: 24 }],
        }) as never,
      sendInputEvent: (ev) => void events.push(ev as { type?: string; x?: number; y?: number; keyCode?: string }),
    };
    return { wc, events };
  }

  it("drives Hyprland desktop via argv-only execFile and AppUiDriver via WebContentsLike", async () => {
    const dataRoot = tempDir();
    const appMock = fakeWebContents();
    const browserMock = fakeWebContents();
    const calls: Array<{ file: string; args: string[] }> = [];
    const bins = new Set(["hyprctl", "grim", "wtype", "python3"]);

    const driver = new HyprlandWaylandDriver({
      dataRoot,
      getAppWebContents: () => appMock.wc,
      getBrowserWebContents: () => browserMock.wc,
      focusAppWindow: () => undefined,
      resolveBin: (b) => (bins.has(b) ? `/usr/bin/${b}` : null),
      uinputWritable: () => true,
      execFileImpl: async (file, args) => {
        calls.push({ file, args });
        if (file.endsWith("hyprctl") && args[1] === "clients") {
          return {
            stdout: JSON.stringify([{ address: "0x12", class: "firefox", title: "Docs", workspace: { name: "1" }, at: [10, 20], size: [800, 600], focusHistoryID: 0 }]),
            stderr: "",
          };
        }
        if (file.endsWith("hyprctl") && args[1] === "monitors") {
          return { stdout: JSON.stringify([{ name: "eDP-1", width: 1920, height: 1080, x: 0, y: 0, scale: 1, focused: true }]), stderr: "" };
        }
        if (file.endsWith("grim")) {
          fs.writeFileSync(args[args.length - 1], pngStub);
        }
        return { stdout: "", stderr: "" };
      },
    });

    const caps = await driver.capabilities();
    expect(caps).toMatchObject({ compositor: "hyprland", canScreenshot: true, canPointer: true, canKeyboard: true, canAppUi: true });

    const shot = await driver.screenshot({ surface: "desktop" });
    expect(fs.existsSync(shot.path)).toBe(true);
    expect(shot.details).toContain('- "Docs" [firefox]');

    const winShot = await driver.screenshot({ surface: "desktop", target: "Docs" });
    expect(winShot.details).toContain('window "Docs"');
    expect(calls.some((c) => c.file === "/usr/bin/grim" && c.args[0] === "-g" && c.args[1] === "10,20 800x600")).toBe(true);

    await driver.act({ action: "focus-window", surface: "desktop", target: "Docs", prompt: "" });
    await driver.act({ action: "click", surface: "desktop", target: "250,180", prompt: "" });
    await driver.act({ action: "scroll", surface: "desktop", target: "", prompt: "down 2" });
    await driver.act({ action: "type", surface: "desktop", target: "", prompt: "hello" });
    await driver.act({ action: "key", surface: "desktop", target: "", prompt: "Ctrl+L" });

    expect(calls.some((c) => c.file === "/usr/bin/hyprctl" && c.args.join(" ") === "dispatch focuswindow address:0x12")).toBe(true);
    expect(calls.some((c) => c.file === "/usr/bin/hyprctl" && c.args.join(" ") === "dispatch movecursor 250 180")).toBe(true);
    expect(calls.some((c) => c.file === "/usr/bin/python3" && c.args[0] === "-I" && c.args[3] === "click")).toBe(true);
    expect(calls.some((c) => c.file === "/usr/bin/python3" && c.args[0] === "-I" && c.args[3] === "scroll-v" && c.args[4] === "-2")).toBe(true);
    expect(calls.some((c) => c.file === "/usr/bin/wtype" && c.args[0] === "--" && c.args[1] === "hello")).toBe(true);
    expect(calls.some((c) => c.file === "/usr/bin/wtype" && c.args.includes("-M") && c.args.includes("l"))).toBe(true);

    // App UI & Browser Dock work directly through WebContents capture & input events
    const appShot = await driver.screenshot({ surface: "app" });
    expect(appShot.details).toContain('[button] "Go" at (120, 40)');
    await driver.act({ action: "click", surface: "app", target: "120,40", prompt: "" });
    await driver.act({ action: "drag", surface: "browser", target: "10,10 -> 50,50", prompt: "" });
    await driver.act({ action: "key", surface: "browser", target: "", prompt: "Ctrl+R" });
    expect(appMock.events.some((e) => e.type === "mouseDown" && e.x === 120 && e.y === 40)).toBe(true);
    expect(browserMock.events.some((e) => e.type === "mouseUp" && e.x === 50 && e.y === 50)).toBe(true);
    expect(browserMock.events.some((e) => e.type === "keyDown" && e.keyCode === "r")).toBe(true);

    // Unsupported driver allows app/browser UI while rejecting desktop control clearly
    const fallback = createComputerUseDriver({ dataRoot, getAppWebContents: () => appMock.wc, getBrowserWebContents: () => null, env: {}, platform: "darwin" });
    expect(fallback).toBeInstanceOf(UnsupportedPlatformDriver);
    await expect(fallback.screenshot({ surface: "desktop" })).rejects.toThrow("Desktop computer control is not available on this display session.");
    expect((await fallback.screenshot({ surface: "app" })).summary).toContain("Captured app");

    // Auto-selects Hyprland / X11 based on session env
    expect(
      createComputerUseDriver({ dataRoot, getAppWebContents: () => null, getBrowserWebContents: () => null, env: { HYPRLAND_INSTANCE_SIGNATURE: "abc", WAYLAND_DISPLAY: "wayland-1" }, platform: "linux" }),
    ).toBeInstanceOf(HyprlandWaylandDriver);
    expect(
      createComputerUseDriver({ dataRoot, getAppWebContents: () => null, getBrowserWebContents: () => null, env: { DISPLAY: ":0" }, platform: "linux" }),
    ).toBeInstanceOf(X11Driver);
  });
});

describe("Viby orchestrator multimodal screen inspection + Go-gated computer steps", () => {
  it("keeps computer steps strictly gated behind Go and passes captured screenshots to follow-up planning turns", async () => {
    const ctx = setupWithClaude();
    const dummyCtx: PlanContext = { workspaces: [], engines: [], running: [] };
    const [resolved] = resolvePlan({ say: "", steps: [{ kind: "computer", action: "click", target: "540,320", options: "surface=desktop" }] }, dummyCtx);
    expect(resolved.kind).toBe("computer");
    expect(holdsForGo(resolved, dummyCtx)).toBe(true);
    expect(safeInCall(resolved, dummyCtx)).toBe(false);

    const pngPath = path.join(tempDir(), "screen.png");
    fs.writeFileSync(pngPath, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    const acted: Array<{ action: string; target: string; surface: string }> = [];
    ctx.host.computer = {
      capabilities: async () => ({
        platform: "linux",
        sessionType: "wayland",
        compositor: "hyprland",
        canScreenshot: true,
        canListWindows: true,
        canPointer: true,
        canKeyboard: true,
        canAppUi: true,
      }),
      listWindows: async () => [],
      screenshot: async ({ surface } = {}) => ({
        path: pngPath,
        width: 1920,
        height: 1080,
        surface: surface ?? "desktop",
        summary: "Captured desktop screen (1 window)",
        details: 'Open windows:\n- "VibeForge" at (0,0) size 1920x1080',
      }),
      act: async (req) => {
        acted.push({ action: req.action, target: req.target, surface: req.surface });
        return "Clicked (540, 320)";
      },
    };

    const runnerInputs: Array<{ argv: string[]; hasStdinImage: boolean }> = [];
    let callNum = 0;
    ctx.svc.orchestrator.runner = async (argv, _cwd, _signal, _timeout, stdin) => {
      callNum += 1;
      runnerInputs.push({ argv, hasStdinImage: Boolean(stdin && stdin.includes('"type":"image"')) });
      if (callNum === 1) {
        return ok(
          JSON.stringify({
            session_id: "s-comp",
            structured_output: {
              say: "Let me inspect your desktop screen first.",
              steps: [{ kind: "inspect", action: "screen", target: "", prompt: "screen" }],
            },
          }),
        );
      }
      return ok(
        JSON.stringify({
          session_id: "s-comp",
          structured_output: {
            say: "I see the Go button at 540, 320. Say go to click it.",
            steps: [{ kind: "computer", action: "click", target: "540,320", options: "surface=app" }],
          },
        }),
      );
    };

    // Even in "go" mode AND even during an active call, computer-use waits for explicit Go!
    await ctx.svc.orchestratorAsk("look at the screen and click Go");
    const planTurn = ctx.svc.orchestratorView().turns.at(-1)!;
    expect(planTurn.plan).toBe("waiting");
    expect(planTurn.steps?.[0].kind).toBe("computer");
    expect(planTurn.checks?.[0].summary).toContain("Captured desktop screen");
    // Follow-up planner invocation received the captured screenshot as a multimodal image!
    expect(runnerInputs[1].hasStdinImage).toBe(true);
    expect(acted).toHaveLength(0);

    // Explicit Go executes the computer step.
    await ctx.svc.orchestratorRun(planTurn.id);
    const doneTurn = ctx.svc.orchestratorView().turns.find((t) => t.id === planTurn.id)!;
    expect(doneTurn.plan).toBe("done");
    expect(doneTurn.steps?.[0].state).toBe("done");
    expect(acted).toEqual([{ action: "click", target: "540,320", surface: "app" }]);
  });
});
