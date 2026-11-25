// Starts the built VibeForge for an end-to-end test and drives it the way a person would: with its
// own scratch config, data, home and Electron profile, stand-in CLIs on a scratch PATH, no network,
// and a fixed window size, time zone and language. See CONTRIBUTING.md ("End-to-end tests").
//
//   const app = await launchApp({ standins: { claude: { plans: [...] } } });
//   await app.go("Viby");
//   await app.click({ name: "Go" });
//   await app.waitFor(`document.querySelector(".toasts")?.innerText.includes("Undo")`, { what: "the Undo toast" });
//
// Every wait is on a condition. When one times out, or the test fails, the scratch folder is kept
// with a screenshot, the page's HTML, the app's output, every live terminal's screen and the
// stand-ins' logs (E2E_OUT, default <tmp>/vibeforge-e2e); a passing test's folder is removed.

import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Readable, Writable } from "node:stream";
import { expect, onTestFinished, type TestContext } from "vitest";
import { type CdpEvent, evaluated, InspectorCdp, PipeCdp } from "./cdp.js";

export const ROOT = path.resolve(import.meta.dirname, "..", "..");
const ELECTRON = path.join(ROOT, "node_modules", "electron", "dist", "electron");
const STANDIN = path.join(ROOT, "e2e", "standins", "standin.cjs");
/** Chromium notices that are not errors in VibeForge (as in scripts/smoke.mjs). */
const BENIGN = [/ResizeObserver loop/];
/** Fixed for every git repository a test makes, so hashes and dates never vary. */
const GIT_IDENTITY = {
  GIT_AUTHOR_NAME: "E2E Tester",
  GIT_AUTHOR_EMAIL: "e2e@example.invalid",
  GIT_COMMITTER_NAME: "E2E Tester",
  GIT_COMMITTER_EMAIL: "e2e@example.invalid",
  GIT_AUTHOR_DATE: "2026-01-01T12:00:00Z",
  GIT_COMMITTER_DATE: "2026-01-01T12:00:00Z",
};
/** What the person's own environment may hand the app: a display and a runtime folder, nothing of theirs. */
const PASSED_THROUGH = ["DISPLAY", "XAUTHORITY", "XDG_RUNTIME_DIR", "TMPDIR", "CI", "GITHUB_ACTIONS"];

export type Plan = { match?: string; structured: { say: string; steps: unknown[]; [key: string]: unknown } };
export type Turn = { match?: string; say?: string[]; files?: Record<string, string>; gate?: string; after?: string[]; exit?: number };
/** How one stand-in CLI behaves (e2e/standins/standin.cjs). */
export type Standin = { plans?: Plan[]; turns?: Turn[] };

export interface LaunchOptions {
  /** Merged over the quiet defaults below (no tray, sounds, notifications, update check or tour). */
  settings?: Record<string, unknown>;
  /** Written as engines.json; left out, VibeForge seeds its own list (claude, codex, …) found on PATH. */
  engines?: unknown[];
  /** Stand-in CLIs, by the name they are run as. */
  standins?: Record<string, Standin>;
  env?: Record<string, string>;
  size?: { width: number; height: number };
  language?: string;
  /** Open the main process's Node inspector, for {@link App.main} and {@link App.refuse}. */
  mainProcess?: boolean;
  /** Page errors this test expects, beyond the benign ones. */
  allowErrors?: RegExp[];
}

export type Paths = {
  root: string;
  home: string;
  config: string;
  data: string;
  profile: string;
  bin: string;
  standins: string;
  evidence: string;
};

export type Spec = { name: string | RegExp; role?: "button" | "menuitem" | "tab" | "link" | "radio" | "textbox" | "checkbox"; within?: string };

const QUIET = {
  tray: false,
  closeToTray: false,
  notify: false,
  tourDone: true,
  checkUpdates: false,
  defaultShell: "/bin/bash",
  activity: "off",
  sounds: { on: false, volume: 0, voice: false, attention: false, finished: false, routines: false, inFront: false },
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const slug = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60) || "app";
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][A-Za-z0-9]|\x1b[=>78]/g;
/** A terminal snapshot as plain text. */
export const plain = (ansi: string) => ansi.replace(ANSI, "").replace(/\r/g, "");

/** Runs in the page: the visible, enabled element a person would call by this name. */
const FIND = `(spec) => {
  const roles = {
    button: "button, [role=button]",
    menuitem: "[role=menuitem], [role=menuitemradio], [role=menuitemcheckbox]",
    tab: "[role=tab]",
    link: "a[href], [role=link]",
    radio: "[role=radio], input[type=radio]",
    textbox: "input:not([type=checkbox]):not([type=radio]), textarea, [role=textbox]",
    checkbox: "[role=checkbox], [role=switch], input[type=checkbox]",
  };
  const selector = spec.role ? roles[spec.role] : Object.values(roles).join(", ");
  const scope = spec.within ? document.querySelector(spec.within) : document;
  if (!scope) return null;
  const want = spec.name;
  const said = (el) => [el.getAttribute("aria-label"), (el.innerText ?? el.textContent ?? "").replace(/\\s+/g, " ").trim(), el.getAttribute("title"), el.getAttribute("placeholder")].filter(Boolean);
  const fits = (text) => (typeof want === "string" ? text === want : new RegExp(want.source, want.flags).test(text));
  const shown = (el) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden";
  return [...scope.querySelectorAll(selector)].find((el) => shown(el) && !el.disabled && el.getAttribute("aria-disabled") !== "true" && said(el).some(fits)) ?? null;
}`;

const specJson = (spec: Spec) => JSON.stringify({ ...spec, name: typeof spec.name === "string" ? spec.name : { source: spec.name.source, flags: spec.name.flags } });

const KEYS: Record<string, { key: string; code: string; vk: number; text?: string }> = {
  enter: { key: "Enter", code: "Enter", vk: 13, text: "\r" },
  escape: { key: "Escape", code: "Escape", vk: 27 },
  esc: { key: "Escape", code: "Escape", vk: 27 },
  backspace: { key: "Backspace", code: "Backspace", vk: 8 },
  tab: { key: "Tab", code: "Tab", vk: 9 },
  space: { key: " ", code: "Space", vk: 32, text: " " },
  arrowup: { key: "ArrowUp", code: "ArrowUp", vk: 38 },
  arrowdown: { key: "ArrowDown", code: "ArrowDown", vk: 40 },
  arrowleft: { key: "ArrowLeft", code: "ArrowLeft", vk: 37 },
  arrowright: { key: "ArrowRight", code: "ArrowRight", vk: 39 },
  delete: { key: "Delete", code: "Delete", vk: 46 },
  home: { key: "Home", code: "Home", vk: 36 },
  end: { key: "End", code: "End", vk: 35 },
};

/** One printable character as Chromium's key events would carry it. */
function charKey(ch: string, shift = false): { key: string; code: string; vk: number; text: string } {
  if (/^[a-z]$/i.test(ch)) return { key: shift ? ch.toUpperCase() : ch, code: `Key${ch.toUpperCase()}`, vk: ch.toUpperCase().charCodeAt(0), text: shift ? ch.toUpperCase() : ch };
  if (/^[0-9]$/.test(ch)) return { key: ch, code: `Digit${ch}`, vk: ch.charCodeAt(0), text: ch };
  if (ch === " ") return { key: " ", code: "Space", vk: 32, text: " " };
  const named: Record<string, [string, number]> = { ",": ["Comma", 188], ".": ["Period", 190], "/": ["Slash", 191], "-": ["Minus", 189], "=": ["Equal", 187], ";": ["Semicolon", 186], "'": ["Quote", 222], "[": ["BracketLeft", 219], "]": ["BracketRight", 221] };
  const [code, vk] = named[ch] ?? ["", 0];
  return { key: ch, code, vk, text: ch };
}

export class App {
  /** Page errors seen so far (their first line), minus the benign and allowed ones. */
  readonly pageErrors: string[] = [];
  /** Every page error in full, allowed ones too, for the evidence. */
  private readonly errorDetails: string[] = [];
  /** Requests to anywhere but this machine, which were refused. */
  readonly blockedRequests: string[] = [];
  private child: ChildProcess | null = null;
  private cdp: PipeCdp | null = null;
  private inspector: InspectorCdp | null = null;
  private session = "";
  private output = "";
  private exited = false;
  private evidenceTaken = false;
  private shots = 0;

  constructor(
    readonly paths: Paths,
    private readonly opts: LaunchOptions,
  ) {}

  /** The app's stdout and stderr so far. */
  get log(): string {
    return this.output;
  }

  async start(): Promise<void> {
    const { paths, opts } = this;
    const headless = process.env.E2E_HEADLESS !== "0";
    const args = [...(opts.mainProcess ? ["--inspect=0"] : []), ROOT, `--user-data-dir=${paths.profile}`, "--remote-debugging-pipe", "--force-device-scale-factor=1", "--lang=en-US"];
    if (process.env.CI) args.push("--no-sandbox");
    if (headless) args.push("--ozone-platform=headless");
    const env: NodeJS.ProcessEnv = {};
    for (const key of PASSED_THROUGH) if (process.env[key] !== undefined) env[key] = process.env[key];
    Object.assign(env, {
      HOME: paths.home,
      XDG_CONFIG_HOME: path.join(paths.root, "xdg-config"),
      XDG_DATA_HOME: path.join(paths.root, "xdg-data"),
      XDG_CACHE_HOME: path.join(paths.root, "xdg-cache"),
      XDG_STATE_HOME: path.join(paths.root, "xdg-state"),
      // The stand-ins first; then Node (the terminal host runs on it) and the system, and nothing
      // from the person's home, where their real CLIs live.
      PATH: [paths.bin, path.dirname(process.execPath), "/usr/local/bin", "/usr/bin", "/bin"].join(path.delimiter),
      VIBEFORGE_CONFIG: paths.config,
      VIBEFORGE_DATA: paths.data,
      VIBEFORGE_DEBUG: "pipe",
      VIBEFORGE_NODE: process.execPath,
      SHELL: "/bin/bash",
      TERM: "xterm-256color",
      TZ: "UTC",
      LANG: "C.UTF-8",
      GIT_CONFIG_NOSYSTEM: "1",
      ...opts.env,
    });
    this.exited = false;
    const child = spawn(ELECTRON, args, { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe", "pipe", "pipe"] });
    this.child = child;
    const logFile = fs.createWriteStream(path.join(paths.root, "app-output.log"), { flags: "a" });
    const keep = (chunk: Buffer) => {
      this.output += chunk.toString("utf8");
      if (this.output.length > 2_000_000) this.output = this.output.slice(-1_000_000);
      logFile.write(chunk);
    };
    child.stdout?.on("data", keep);
    child.stderr?.on("data", keep);
    child.on("exit", () => {
      this.exited = true;
      logFile.end();
    });
    this.cdp = new PipeCdp(child.stdio[3] as Writable, child.stdio[4] as Readable);
    this.cdp.on((event) => this.onEvent(event));
    await this.attach();
    if (opts.mainProcess) await this.connectInspector();
  }

  private async attach(): Promise<void> {
    const cdp = this.cdp!;
    const deadline = Date.now() + 30_000;
    let target: { targetId: string } | undefined;
    while (!target) {
      if (this.exited) throw new Error(`The app exited during start.\n${this.output.slice(-4000)}`);
      if (Date.now() > deadline) throw new Error(`The window never appeared.\n${this.output.slice(-4000)}`);
      const { targetInfos } = await cdp.send<{ targetInfos: Array<{ targetId: string; type: string; url: string }> }>("Target.getTargets", {}, undefined, 2000).catch(() => ({ targetInfos: [] }));
      target = targetInfos.find((item) => item.type === "page" && item.url.includes("index.html"));
      if (!target) await sleep(100);
    }
    const { sessionId } = await cdp.send<{ sessionId: string }>("Target.attachToTarget", { targetId: target.targetId, flatten: true });
    this.session = sessionId;
    const size = this.opts.size ?? { width: 1400, height: 900 };
    await this.send("Runtime.enable");
    await this.send("Log.enable");
    await this.send("Page.enable");
    await this.send("Emulation.setDeviceMetricsOverride", { width: size.width, height: size.height, deviceScaleFactor: 1, mobile: false });
    await this.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
    // A hidden or virtual window is never "looking"; the page has to believe it is, as a person's would.
    await this.send("Emulation.setFocusEmulationEnabled", { enabled: true });
    await this.send("Page.addScriptToEvaluateOnNewDocument", { source: "document.hasFocus = () => true;" });
    await this.send("Fetch.enable", { patterns: [{ urlPattern: "http://*" }, { urlPattern: "https://*" }] });
    await this.eval(`document.hasFocus = () => true; window.dispatchEvent(new Event("focus")); true`);
    await this.waitFor(`Boolean(document.querySelector("nav.rail") && document.querySelector(".stage"))`, { what: "the window to open", timeoutMs: 30_000 });
  }

  private async connectInspector(): Promise<void> {
    const deadline = Date.now() + 15_000;
    let url: string | undefined;
    while (!url) {
      url = this.output.match(/Debugger listening on (ws:\/\/\S+)/)?.[1];
      if (url) break;
      if (Date.now() > deadline) throw new Error("The main process's inspector never said where it listens.");
      await sleep(50);
    }
    this.inspector = await InspectorCdp.connect(url);
  }

  private onEvent(event: CdpEvent): void {
    if (event.sessionId !== this.session) return;
    // The few fields read here, from Fetch.requestPaused, Runtime and Log events.
    const params = event.params as {
      requestId?: string;
      request?: { url?: string };
      type?: string;
      args?: Array<{ value?: unknown; description?: string }>;
      exceptionDetails?: { text?: string; exception?: { description?: string } };
      entry?: { level?: string; text?: string };
    };
    if (event.method === "Fetch.requestPaused") {
      const url = String(params.request?.url ?? "");
      const local = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/.test(url);
      if (!local) this.blockedRequests.push(url);
      void this.send(local ? "Fetch.continueRequest" : "Fetch.failRequest", local ? { requestId: params.requestId } : { requestId: params.requestId, errorReason: "BlockedByClient" }).catch(() => undefined);
      return;
    }
    let error: string | null = null;
    if (event.method === "Runtime.exceptionThrown") error = params.exceptionDetails?.exception?.description ?? params.exceptionDetails?.text ?? "exception";
    if (event.method === "Runtime.consoleAPICalled" && params.type === "error") error = (params.args ?? []).map((arg) => String(arg.value ?? arg.description ?? "")).join(" ");
    if (event.method === "Log.entryAdded" && params.entry?.level === "error") error = String(params.entry?.text ?? "");
    if (error === null) return;
    this.errorDetails.push(error);
    const first = error.split("\n")[0];
    if ([...BENIGN, ...(this.opts.allowErrors ?? [])].some((pattern) => pattern.test(error!))) return;
    this.pageErrors.push(first);
  }

  send<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}, timeoutMs?: number): Promise<T> {
    if (!this.cdp) return Promise.reject(new Error("The app isn't running."));
    return this.cdp.send<T>(method, params, this.session, timeoutMs);
  }

  /** Evaluate in the window and return the value; promises are awaited. */
  async eval<T = unknown>(expression: string, timeoutMs = 20_000): Promise<T> {
    return evaluated<T>(await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, timeoutMs));
  }

  /** One of VibeForge's own calls from the window to the main process (window.vibeforge.call). */
  call<T = unknown>(method: string, ...params: unknown[]): Promise<T> {
    return this.eval<T>(`window.vibeforge.call(${JSON.stringify(method)}, ...${JSON.stringify(params)})`);
  }

  /** Evaluate in the main process (needs `mainProcess: true`). `require` is the main process's own. */
  async main<T = unknown>(expression: string): Promise<T> {
    if (!this.inspector) throw new Error("Start the app with mainProcess: true to reach the main process.");
    const wrapped = `(async () => { const require = process.mainModule?.require ?? globalThis.require; return (${expression}); })()`;
    return evaluated<T>(await this.inspector.send("Runtime.evaluate", { expression: wrapped, awaitPromise: true, returnByValue: true }));
  }

  /**
   * Make the main process refuse these calls from the window with this error, as a folder it can't
   * read would; `refuse([])` reads normally again. Every call still goes through VibeForge's own
   * handler, so the window sees exactly what a real failure looks like.
   */
  async refuse(methods: string[], message = "EACCES: permission denied, scandir '/home/someone/.config/vibeforge'"): Promise<void> {
    await this.main(`(() => {
      const { ipcMain } = require("electron");
      const handlers = ipcMain._invokeHandlers;
      if (!globalThis.__e2eRealCall) globalThis.__e2eRealCall = handlers.get("vf:call");
      const real = globalThis.__e2eRealCall;
      const refused = new Set(${JSON.stringify(methods)});
      handlers.set("vf:call", async (event, method, ...args) => {
        if (refused.has(method)) throw new Error(${JSON.stringify(message)});
        return real(event, method, ...args);
      });
      return true;
    })()`);
  }

  /**
   * Wait until the check is truthy and return its value. A string is evaluated in the window; a
   * function runs here. On timeout the evidence is saved and the error names what was awaited.
   */
  async waitFor<T>(check: string | (() => T | Promise<T>), { what, timeoutMs = 10_000 }: { what: string; timeoutMs?: number }): Promise<NonNullable<T>> {
    const deadline = Date.now() + timeoutMs;
    let last: unknown;
    let lastError: unknown;
    for (;;) {
      if (this.exited) {
        await this.evidence(`the app exited while waiting for ${what}`);
        throw new Error(`The app exited while waiting for ${what}.\n${this.output.slice(-3000)}`);
      }
      try {
        last = typeof check === "string" ? await this.eval(check, Math.max(1000, deadline - Date.now())) : await check();
        lastError = undefined;
        if (last) return last as NonNullable<T>;
      } catch (error) {
        lastError = error;
      }
      if (Date.now() > deadline) break;
      await sleep(100);
    }
    const why = lastError instanceof Error ? lastError.message : JSON.stringify(last);
    const folder = await this.evidence(`timed out waiting for ${what}`);
    throw new Error(`Timed out after ${timeoutMs} ms waiting for ${what} (last: ${why}). Evidence: ${folder}`);
  }

  /** The element a person would call by this name, once it is on screen; null if it never shows. */
  has(spec: Spec): Promise<boolean> {
    return this.eval<boolean>(`Boolean((${FIND})(${specJson(spec)}))`);
  }

  /** Click what a person would call by this name, with the mouse, where it is drawn. */
  async click(spec: Spec, { timeoutMs = 10_000 }: { timeoutMs?: number } = {}): Promise<void> {
    const label = `${spec.role ?? "control"} "${String(spec.name)}"${spec.within ? ` in ${spec.within}` : ""}`;
    const point = await this.waitFor(
      `(() => {
        const el = (${FIND})(${specJson(spec)});
        if (!el) return null;
        el.scrollIntoView({ block: "center", inline: "center" });
        const box = el.getBoundingClientRect();
        const x = box.left + box.width / 2, y = box.top + box.height / 2;
        const hit = document.elementFromPoint(x, y);
        return hit && (hit === el || el.contains(hit)) ? { x, y } : null;
      })()`,
      { what: `${label} to be on screen and not covered`, timeoutMs },
    );
    const { x, y } = point as { x: number; y: number };
    await this.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    await this.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 });
    await this.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1 });
  }

  /** Press a key or a chord: "Enter", "Ctrl+K", "Ctrl+Shift+D", "Escape". */
  async key(chord: string): Promise<void> {
    const parts = chord.split("+");
    const name = parts.pop()!;
    const mods = new Set(parts.map((part) => part.toLowerCase()));
    const modifiers = (mods.has("alt") ? 1 : 0) | (mods.has("ctrl") ? 2 : 0) | (mods.has("meta") ? 4 : 0) | (mods.has("shift") ? 8 : 0);
    const spec = KEYS[name.toLowerCase()] ?? charKey(name.length === 1 ? name : name.toLowerCase(), mods.has("shift"));
    const text = modifiers & ~8 ? undefined : spec.text;
    await this.send("Input.dispatchKeyEvent", { type: text ? "keyDown" : "rawKeyDown", key: spec.key, code: spec.code, windowsVirtualKeyCode: spec.vk, modifiers, ...(text ? { text, unmodifiedText: text } : {}) });
    await this.send("Input.dispatchKeyEvent", { type: "keyUp", key: spec.key, code: spec.code, windowsVirtualKeyCode: spec.vk, modifiers });
  }

  /** Type text key by key, as a keyboard would: each character is its own keydown, input and keyup. */
  async type(text: string): Promise<void> {
    for (const ch of text) {
      if (ch === "\n") {
        await this.key("Enter");
        continue;
      }
      const shift = /[A-Z]/.test(ch);
      const spec = charKey(ch, shift);
      const modifiers = shift ? 8 : 0;
      await this.send("Input.dispatchKeyEvent", { type: "keyDown", key: spec.key, code: spec.code, windowsVirtualKeyCode: spec.vk, modifiers, text: spec.text, unmodifiedText: spec.text });
      await this.send("Input.dispatchKeyEvent", { type: "keyUp", key: spec.key, code: spec.code, windowsVirtualKeyCode: spec.vk, modifiers });
    }
  }

  /** Paste-like input: the whole text at once into whatever has focus. */
  insertText(text: string): Promise<unknown> {
    return this.send("Input.insertText", { text });
  }

  /** Open a view from the rail by its name, and wait until it is the current one. */
  async go(view: string): Promise<void> {
    const button = `[...document.querySelectorAll("nav.rail button.rail-btn")].find((b) => b.getAttribute("aria-label") === ${JSON.stringify(view)})`;
    await this.waitFor(`Boolean(${button})`, { what: `${view} in the rail` });
    await this.eval(`${button}.click(), true`);
    await this.waitFor(`${button}?.getAttribute("aria-current") === "page" && !document.querySelector(".stage .skeleton.is-page")`, { what: `${view} to open` });
  }

  /** The visible text of what matches the selector, or "" when nothing does. */
  text(selector = ".stage"): Promise<string> {
    return this.eval<string>(`document.querySelector(${JSON.stringify(selector)})?.innerText ?? ""`);
  }

  /** A terminal, read through the host's own snapshot of its screen and scrollback. */
  terminal(ptyId: string) {
    const read = async () => plain(String((await this.call<{ ansi: string }>("pty.snapshot", ptyId))?.ansi ?? ""));
    return {
      read,
      waitForText: (pattern: RegExp | string, timeoutMs = 15_000) =>
        this.waitFor(
          async () => {
            const text = await read();
            return (typeof pattern === "string" ? text.includes(pattern) : pattern.test(text)) ? text : null;
          },
          { what: `terminal ${ptyId} to show ${String(pattern)}`, timeoutMs },
        ),
    };
  }

  /** A stand-in CLI: what it was started with, and its gates. */
  standin(name: string) {
    const folder = this.paths.standins;
    return {
      calls: (): Array<{ argv: string[]; cwd: string; mode: string; [key: string]: unknown }> => {
        const file = path.join(folder, `${name}.calls.jsonl`);
        if (!fs.existsSync(file)) return [];
        return fs
          .readFileSync(file, "utf8")
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line));
      },
    };
  }

  /** Wait until a stand-in's turn is held at this gate. */
  waitForGate(gate: string, timeoutMs = 15_000): Promise<true> {
    return this.waitFor(() => fs.existsSync(path.join(this.paths.standins, "gates", `${gate}.waiting`)), { what: `a stand-in to reach the gate "${gate}"`, timeoutMs }) as Promise<true>;
  }

  /** Let the stand-in held at this gate finish its turn. */
  openGate(gate: string): void {
    const gates = path.join(this.paths.standins, "gates");
    fs.mkdirSync(gates, { recursive: true });
    fs.writeFileSync(path.join(gates, gate), "");
  }

  /** A git repository under the scratch home, with a fixed identity and date. Returns its folder. */
  repo(name: string, files: Record<string, string>, message = "First commit"): string {
    const folder = path.join(this.paths.home, "Projects", name);
    fs.mkdirSync(folder, { recursive: true });
    for (const [file, text] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(folder, file)), { recursive: true });
      fs.writeFileSync(path.join(folder, file), text);
    }
    this.git(folder, "init", "-q", "-b", "main");
    this.git(folder, "add", "-A");
    this.git(folder, "commit", "-q", "-m", message);
    return folder;
  }

  /** git in a folder, with the tests' identity and no config of the person's. */
  git(cwd: string, ...args: string[]): string {
    return execFileSync("git", ["-c", "commit.gpgsign=false", ...args], {
      cwd,
      env: { PATH: process.env.PATH, HOME: this.paths.home, GIT_CONFIG_NOSYSTEM: "1", ...GIT_IDENTITY },
      encoding: "utf8",
    });
  }

  /** Save a screenshot beside the evidence; returns its path. */
  async screenshot(name = `shot-${++this.shots}`): Promise<string> {
    const file = path.join(this.paths.evidence, `${slug(name)}.png`);
    fs.mkdirSync(this.paths.evidence, { recursive: true });
    const { data } = await this.send<{ data: string }>("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(file, Buffer.from(data, "base64"));
    return file;
  }

  /**
   * Keep what explains a failure: a screenshot, the page's HTML, the app's output, each live
   * terminal's screen and a note of why. Returns the folder. Only the first call writes.
   */
  async evidence(why: string): Promise<string> {
    const folder = this.paths.evidence;
    if (this.evidenceTaken) return folder;
    this.evidenceTaken = true;
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, "why.txt"), `${why}\n\nPage errors:\n${this.errorDetails.join("\n\n") || "none"}\n\nRefused requests:\n${this.blockedRequests.join("\n") || "none"}\n`);
    const quietly = async (step: () => Promise<unknown>) => {
      try {
        await Promise.race([step(), sleep(5000)]);
      } catch {
        /* the window may be gone; keep what can be kept */
      }
    };
    if (!this.exited) {
      await quietly(() => this.screenshot("failure"));
      await quietly(async () => fs.writeFileSync(path.join(folder, "page.html"), await this.eval<string>("document.documentElement.outerHTML", 5000)));
      await quietly(async () => {
        const live = await this.call<Array<{ ptyId: string }>>("live.list");
        for (const session of live ?? []) {
          const text = await this.terminal(session.ptyId).read();
          fs.writeFileSync(path.join(folder, `terminal-${slug(session.ptyId)}.txt`), text);
        }
      });
    }
    fs.writeFileSync(path.join(folder, "app-output.log"), this.output);
    return folder;
  }

  /** Load the window's page again, as Ctrl+R would, and wait for it to open. */
  async reload(): Promise<void> {
    await this.send("Page.reload", { ignoreCache: true });
    await this.waitFor(`document.readyState === "complete" && Boolean(document.querySelector("nav.rail") && document.querySelector(".stage"))`, { what: "the window to open again" });
  }

  /** Quit the app and start it again on the same folders. */
  async restart(): Promise<void> {
    await this.stop();
    this.evidenceTaken = false;
    await this.start();
  }

  /** Quit the way the desktop asks a program to (SIGTERM), then wait for it to be gone. */
  async stop(): Promise<void> {
    this.inspector?.close();
    this.inspector = null;
    const child = this.child;
    if (child && !this.exited) {
      child.kill("SIGTERM");
      const deadline = Date.now() + 15_000;
      while (!this.exited && Date.now() < deadline) await sleep(50);
      if (!this.exited) child.kill("SIGKILL");
      while (!this.exited) await sleep(50);
    }
    this.cdp?.dispose("the app quit");
    this.cdp = null;
    this.child = null;
  }
}

function testName(context?: TestContext): string {
  const name = context?.task.name ?? expect.getState().currentTestName ?? "app";
  return slug(name);
}

/** Where scratch folders go: E2E_OUT, or a folder in the system's temporary directory. */
export const OUT = process.env.E2E_OUT ? path.resolve(process.env.E2E_OUT) : path.join(os.tmpdir(), "vibeforge-e2e");

/**
 * Start the built app for the current test. It is quit when the test ends; its folder is removed
 * when the test passed (unless E2E_KEEP=1) and kept, with the evidence, when it failed.
 */
export async function launchApp(opts: LaunchOptions = {}, context?: TestContext): Promise<App> {
  for (const file of ["dist/index.html", "dist-electron/main.js"]) {
    if (!fs.existsSync(path.join(ROOT, file))) throw new Error(`${file} is missing: run npm run build first.`);
  }
  fs.mkdirSync(OUT, { recursive: true });
  const root = fs.mkdtempSync(path.join(OUT, `${testName(context)}-`));
  const paths: Paths = {
    root,
    home: path.join(root, "home"),
    config: path.join(root, "config"),
    data: path.join(root, "data"),
    profile: path.join(root, "profile"),
    bin: path.join(root, "bin"),
    standins: path.join(root, "standins"),
    evidence: path.join(root, "evidence"),
  };
  for (const dir of [paths.home, paths.config, paths.bin, paths.standins]) fs.mkdirSync(dir, { recursive: true });
  // The same short prompt everywhere, without the machine's user or host name.
  fs.writeFileSync(path.join(paths.home, ".bash_profile"), "PS1='e2e:\\W\\$ '\n");
  fs.writeFileSync(path.join(paths.home, ".gitconfig"), "[user]\n\tname = E2E Tester\n\temail = e2e@example.invalid\n[init]\n\tdefaultBranch = main\n[commit]\n\tgpgsign = false\n");
  fs.writeFileSync(path.join(paths.config, "settings.json"), JSON.stringify({ ...QUIET, language: opts.language ?? "en", ...opts.settings }, null, 2));
  if (opts.engines) fs.writeFileSync(path.join(paths.config, "engines.json"), JSON.stringify({ engines: opts.engines }, null, 2));
  // Each stand-in runs as `node <name>.cjs`, as an npm-installed CLI runs as `node cli.js`: VibeForge
  // names a shell's foreground program by the script an interpreter runs, so `claude` typed in a
  // shell is recognised as Claude Code.
  const scripts = path.join(paths.root, "standin-scripts");
  fs.mkdirSync(scripts, { recursive: true });
  for (const [name, standin] of Object.entries(opts.standins ?? {})) {
    fs.writeFileSync(path.join(paths.standins, `${name}.json`), JSON.stringify(standin, null, 2));
    fs.symlinkSync(STANDIN, path.join(scripts, `${name}.cjs`));
    const quote = (text: string) => `'${text.replace(/'/g, `'\\''`)}'`;
    fs.writeFileSync(path.join(paths.bin, name), `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(path.join(scripts, `${name}.cjs`))} ${quote(name)} ${quote(paths.standins)} "$@"\n`, { mode: 0o755 });
  }
  const app = new App(paths, opts);
  let failed = false;
  onTestFinished(async ({ task }) => {
    failed = task.result?.state === "fail";
    if (failed) await app.evidence(`the test failed: ${task.result?.errors?.map((error) => error.message).join("\n") ?? ""}`);
    await app.stop();
    if (!failed && process.env.E2E_KEEP !== "1") fs.rmSync(root, { recursive: true, force: true });
    else fs.rmSync(path.join(root, "profile"), { recursive: true, force: true });
  });
  try {
    await app.start();
  } catch (error) {
    await app.evidence(`the app did not start: ${error instanceof Error ? error.message : String(error)}`);
    throw error;
  }
  return app;
}
