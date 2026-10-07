#!/usr/bin/env node
// A smoke test of the built app: start it with a throwaway profile, open every view, change the
// language, use Ctrl+K and a real shell, and fail on any error the page reports. It drives the
// window over the DevTools protocol, so nothing but Node and the built app is needed.
//
//   npm run build && node scripts/smoke.mjs        (on CI: xvfb-run -a node scripts/smoke.mjs)
//
// SMOKE_HEADLESS=1 starts it without a window. SMOKE_ATTACH=1 drives a window someone else started (with VIBEFORGE_DEBUG=1 and the port in
// SMOKE_PORT), for a desktop where a new window shouldn't appear in front of you.

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const port = Number(process.env.SMOKE_PORT || 9331);
const electron = path.join(root, "node_modules", "electron", "dist", "electron");
/** Chromium notices that are not errors in VibeForge (see PageErrors in src/core/log.ts). */
const BENIGN = [/ResizeObserver loop/];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const failures = [];
const step = (text) => console.log(`· ${text}`);
const fail = (text) => {
  failures.push(text);
  console.log(`  ✗ ${text}`);
};

// ------------------------------------------------------------------ a throwaway profile

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "vibeforge-smoke-"));
const home = path.join(scratch, "home");
const config = path.join(scratch, "config");
const workspace = path.join(scratch, "project");
for (const dir of [home, config, workspace]) fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(workspace, "README.md"), "smoke\n");
// Quiet: no tray icon, sounds, notifications, update checks or tour.
fs.writeFileSync(
  path.join(config, "settings.json"),
  JSON.stringify({
    tray: false,
    closeToTray: false,
    notify: false,
    tourDone: true,
    checkUpdates: false,
    defaultShell: "/bin/bash",
    activity: "off",
    sounds: { on: false, volume: 0, voice: false, attention: false, finished: false, routines: false, inFront: false },
  }),
);

// A stand-in CLI that prints a line and fails, so a real run is recorded without any model CLI.
fs.writeFileSync(
  path.join(config, "engines.json"),
  JSON.stringify({ engines: [{ id: "smoke", label: "Smoke CLI", bin: "/bin/sh", args: ["-c", "echo SMOKE-RUN; sleep 1; exit 3"] }] }),
);

const attach = process.env.SMOKE_ATTACH === "1";
for (const file of attach ? [] : ["dist/index.html", "dist-electron/main.js"]) {
  if (!fs.existsSync(path.join(root, file))) {
    console.error(`${file} is missing. Run npm run build first.`);
    process.exit(2);
  }
}

const args = [root, `--user-data-dir=${path.join(scratch, "profile")}`];
// CI runners have no setuid sandbox helper.
if (process.env.CI) args.push("--no-sandbox");
// SMOKE_HEADLESS=1 draws nowhere at all, for a run on a desktop you're using.
if (process.env.SMOKE_HEADLESS === "1") args.push("--ozone-platform=headless");
const app = attach ? null : spawn(electron, args, {
  cwd: root,
  env: {
    ...process.env,
    HOME: home,
    VIBEFORGE_CONFIG: config,
    VIBEFORGE_DATA: path.join(scratch, "data"),
    VIBEFORGE_DEBUG: "1",
    VIBEFORGE_DEBUG_PORT: String(port),
    SHELL: "/bin/bash",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let appOutput = "";
app?.stdout.on("data", (chunk) => (appOutput += chunk));
app?.stderr.on("data", (chunk) => (appOutput += chunk));
let exited = false;
app?.on("exit", () => (exited = true));

// ------------------------------------------------------------------ DevTools

async function pageTarget() {
  for (let tries = 0; tries < 150; tries += 1) {
    if (exited) throw new Error(`The app exited during start.\n${appOutput}`);
    try {
      const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      const page = targets.find((target) => target.type === "page" && target.url.includes("index.html"));
      if (page) return page;
    } catch {
      /* not listening yet */
    }
    await sleep(200);
  }
  throw new Error("The window never appeared.");
}

let socket;
let nextId = 0;
const waiting = new Map();

function send(method, params = {}, timeoutMs = 10_000) {
  const id = ++nextId;
  socket.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      waiting.delete(id);
      reject(new Error(`${method} timed out`));
    }, timeoutMs);
    waiting.set(id, { resolve, reject, timer });
  });
}

/** Evaluate in the page and return the value. Promises are awaited. */
async function page(expression, timeoutMs) {
  const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, timeoutMs);
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
  return result.result.value;
}

async function until(expression, what, timeoutMs = 8000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await page(expression).catch(() => false)) return true;
    await sleep(100);
  }
  fail(`timed out waiting for ${what}`);
  return false;
}

const call = (method, ...params) => page(`window.vibeforge.call(${JSON.stringify(method)}, ...${JSON.stringify(params)})`, 20_000);

async function key(keyName, code, modifiers = 0) {
  for (const type of ["keyDown", "keyUp"]) await send("Input.dispatchKeyEvent", { type, key: keyName, code, modifiers, windowsVirtualKeyCode: keyName.length === 1 ? keyName.toUpperCase().charCodeAt(0) : 0 });
}

// ------------------------------------------------------------------ the run

async function main() {
  const target = await pageTarget();
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = () => reject(new Error("Could not reach DevTools."));
  });
  socket.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.id && waiting.has(message.id)) {
      const { resolve, reject, timer } = waiting.get(message.id);
      clearTimeout(timer);
      waiting.delete(message.id);
      if (message.error) reject(new Error(message.error.message));
      else resolve(message.result);
      return;
    }
    const pageError = (text) => !BENIGN.some((pattern) => pattern.test(text)) && fail(`page error: ${text.split("\n")[0]}`);
    if (message.method === "Runtime.exceptionThrown") pageError(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text);
    if (message.method === "Runtime.consoleAPICalled" && message.params.type === "error") pageError(message.params.args.map((arg) => arg.value ?? arg.description ?? "").join(" "));
    if (message.method === "Log.entryAdded" && message.params.entry.level === "error") pageError(message.params.entry.text);
  };
  await send("Runtime.enable");
  await send("Log.enable");
  // The hidden or virtual display may never be "looking"; let the page believe it is.
  await page(`document.hasFocus = () => true; window.dispatchEvent(new Event("focus")); true`);

  step("the window opens on Home");
  await until(`Boolean(document.querySelector("nav.rail") && document.querySelector(".stage .main, .stage .view"))`, "the first view");

  step("every view in the rail opens");
  const views = await page(`[...document.querySelectorAll("nav.rail > button.rail-btn[aria-label]")].map((button) => button.getAttribute("aria-label"))`);
  if (views.length < 5) fail(`only ${views.length} views in the rail`);
  for (const [index, label] of views.entries()) {
    await page(`document.querySelectorAll("nav.rail > button.rail-btn[aria-label]")[${index}].click(), true`);
    await until(`document.querySelectorAll("nav.rail > button.rail-btn[aria-label]")[${index}].getAttribute("aria-current") === "page"`, `${label} to be current`);
    await until(`!document.querySelector(".stage .skeleton.is-page") && Boolean(document.querySelector(".stage .main, .stage .view, .stage .code-main, .stage .empty"))`, `${label} to render`);
    const crashed = await page(`document.querySelector(".stage")?.innerText.includes("This view hit a problem") ?? false`);
    if (crashed) fail(`${label} crashed`);
  }

  step("Settings open, in English and then in German");
  await page(`[...document.querySelectorAll(".rail-foot .rail-btn")].at(-1).click(), true`);
  await until(`Boolean(document.getElementById("settings-storage"))`, "Settings with the Storage section");
  await call("settings.save", { language: "de" });
  await until(`document.documentElement.lang === "de" && document.querySelector(".page-head h1")?.textContent === "Einstellungen"`, "the German Settings heading");
  await call("settings.save", { language: "en" });
  await until(`document.querySelector(".page-head h1")?.textContent === "Settings"`, "English again");

  step("Ctrl+K finds things by name");
  await key("k", "KeyK", 2);
  await until(`Boolean(document.querySelector(".switcher input"))`, "the switcher");
  await send("Input.insertText", { text: "sett" });
  await until(`document.querySelectorAll(".switcher-list .row").length > 0`, "a switcher result");
  await key("Escape", "Escape");
  await until(`!document.querySelector(".switcher")`, "the switcher to close");

  step("a workspace and a real shell");
  const added = await call("workspaces.add", workspace);
  const shell = await call("code.shell", { cwd: workspace, cols: 100, rows: 30 });
  await sleep(500);
  await call("pty.write", shell.ptyId, "echo SMOKE-$((20+22))\r");
  await until(`window.vibeforge.call("pty.snapshot", ${JSON.stringify(shell.ptyId)}).then((snap) => snap.ansi.includes("SMOKE-42"))`, "the shell to answer", 15_000);
  await call("pty.kill", shell.ptyId);

  // An attached window has its own config, without the stand-in CLI.
  if (!attach) {
    step("a finished run copies as Markdown");
    const workspaceId = added.workspaces.find((item) => item.path === workspace)?.id;
    const run = await call("code.engine", { workspaceId, engineId: "smoke", cols: 100, rows: 30 });
    await until(`window.vibeforge.call("runs.get", ${JSON.stringify(run.runId)}).then((bundle) => bundle.run.status !== "running")`, "the stand-in CLI to finish", 15_000);
    const markdown = await call("runs.markdown", run.runId);
    for (const part of ["- **CLI:** Smoke CLI", "exited with code 3", "SMOKE-RUN"]) {
      if (!String(markdown).includes(part)) fail(`runs.markdown is missing "${part}"`);
    }
  }

  step("storage and search answer");
  const storage = await call("storage.summary");
  if (typeof storage?.runs !== "number") fail("storage.summary returned nothing");
  const hits = await call("runs.search", "smoke");
  if (!Array.isArray(hits)) fail("runs.search did not return a list");
}

let code = 0;
try {
  await main();
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
} finally {
  socket?.close();
  if (app) {
    app.kill("SIGTERM");
    for (let tries = 0; tries < 50 && !exited; tries += 1) await sleep(100);
    if (!exited) app.kill("SIGKILL");
  }
  fs.rmSync(scratch, { recursive: true, force: true });
}
if (failures.length) {
  console.log(`\n${failures.length} problem${failures.length === 1 ? "" : "s"}.`);
  if (process.env.CI) console.log(`\nApp output:\n${appOutput.slice(-4000)}`);
  code = 1;
} else console.log("\nSmoke test passed.");
process.exit(code);
