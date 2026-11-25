// Pure shared types, validation, and human descriptions for Viby's safe Computer Use capability.
// Node-free so the desktop UI, service layer, and phone companion validate computer steps identically.

import { parseOptions } from "./orchestrator-actions.js";
import type { StepIssue } from "./orchestrator.js";

export type ComputerActionKind =
  | "screenshot"
  | "windows"
  | "focus-window"
  | "click"
  | "double-click"
  | "right-click"
  | "move"
  | "drag"
  | "scroll"
  | "type"
  | "key"
  | "wait";

export type ComputerSurface = "desktop" | "app" | "browser";

const ACTION_ALIASES: Record<string, ComputerActionKind> = {
  screenshot: "screenshot",
  screen: "screenshot",
  capture: "screenshot",
  snapshot: "screenshot",
  grab: "screenshot",
  windows: "windows",
  listwindows: "windows",
  openwindows: "windows",
  focuswindow: "focus-window",
  focus: "focus-window",
  focusapp: "focus-window",
  switchwindow: "focus-window",
  activatewindow: "focus-window",
  click: "click",
  leftclick: "click",
  tap: "click",
  doubleclick: "double-click",
  dblclick: "double-click",
  rightclick: "right-click",
  contextclick: "right-click",
  secondaryclick: "right-click",
  move: "move",
  movecursor: "move",
  mousemove: "move",
  hover: "move",
  drag: "drag",
  mousedrag: "drag",
  scroll: "scroll",
  wheel: "scroll",
  scrollwheel: "scroll",
  type: "type",
  write: "type",
  input: "type",
  entertext: "type",
  key: "key",
  keypress: "key",
  shortcut: "key",
  hotkey: "key",
  sendkey: "key",
  wait: "wait",
  sleep: "wait",
  pause: "wait",
};

const MODIFIER_ALIASES: Record<string, "ctrl" | "alt" | "shift" | "super"> = {
  ctrl: "ctrl",
  control: "ctrl",
  alt: "alt",
  shift: "shift",
  super: "super",
  meta: "super",
  win: "super",
  cmd: "super",
};

const NAMED_KEYS: Record<string, string> = {
  return: "Return",
  enter: "Return",
  escape: "Escape",
  esc: "Escape",
  tab: "Tab",
  backspace: "BackSpace",
  delete: "Delete",
  del: "Delete",
  space: "space",
  up: "Up",
  down: "Down",
  left: "Left",
  right: "Right",
  home: "Home",
  end: "End",
  pageup: "Prior",
  page_up: "Prior",
  pagedown: "Next",
  page_down: "Next",
  insert: "Insert",
};

const squash = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, "");

export function normalizeComputerAction(raw: string | undefined): ComputerActionKind | null {
  const key = squash(raw ?? "");
  return key ? (ACTION_ALIASES[key] ?? null) : null;
}

export function isReadOnlyComputerAction(action: ComputerActionKind | null): boolean {
  return action === "screenshot" || action === "windows";
}

export function parseComputerSurface(options: string | undefined, target?: string): ComputerSurface {
  const opt = squash(parseOptions(options).str("surface") ?? "");
  if (opt === "app" || opt === "vibeforge") return "app";
  if (opt === "browser" || opt === "dock") return "browser";
  if (opt === "desktop") return "desktop";
  const tgt = (target ?? "").trim().toLowerCase();
  if (tgt === "app" || tgt === "vibeforge") return "app";
  if (tgt === "browser" || tgt === "dock" || tgt === "browser-dock") return "browser";
  return "desktop";
}

export function parseComputerCoordinates(raw: string | undefined): { x: number; y: number } | null {
  const text = (raw ?? "").trim();
  if (!text) return null;
  const m = /^\(?\s*(?:x\s*[:=]\s*)?(\d{1,5})\s*(?:[,;\s×]|x(?=\s*\d))\s*(?:y\s*[:=]\s*)?(\d{1,5})\s*\)?$/i.exec(text);
  if (!m) return null;
  const x = Number(m[1]);
  const y = Number(m[2]);
  if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || x > 16384 || y < 0 || y > 16384) return null;
  return { x, y };
}

export function parseComputerDrag(raw: string | undefined): { fromX: number; fromY: number; toX: number; toY: number } | null {
  const text = (raw ?? "").trim();
  if (!text) return null;
  const parts = text.split(/\s*(?:->|=>|to|;)\s*/i);
  if (parts.length !== 2) return null;
  const from = parseComputerCoordinates(parts[0]);
  const to = parseComputerCoordinates(parts[1]);
  if (!from || !to) return null;
  return { fromX: from.x, fromY: from.y, toX: to.x, toY: to.y };
}

export function parseComputerScroll(raw: string | undefined): { direction: "up" | "down" | "left" | "right"; amount: number } | null {
  const text = (raw ?? "").trim().toLowerCase();
  if (!text) return null;
  const m = /^(up|down|left|right)(?:\s+(-?\d{1,3}))?$/.exec(text);
  if (!m) return null;
  const direction = m[1] as "up" | "down" | "left" | "right";
  const rawAmt = m[2] ? Math.abs(Number(m[2])) : 3;
  const amount = Math.max(1, Math.min(20, rawAmt || 3));
  return { direction, amount };
}

export function validateKeyCombo(raw: string | undefined): { modifiers: Array<"ctrl" | "alt" | "shift" | "super">; key: string } | null {
  const text = (raw ?? "").trim();
  if (!text || text.length > 64) return null;
  const parts = text.split(/[+\s]+/).filter(Boolean);
  if (!parts.length || parts.length > 5) return null;
  const modifiers: Array<"ctrl" | "alt" | "shift" | "super"> = [];
  for (let i = 0; i < parts.length - 1; i += 1) {
    const mod = MODIFIER_ALIASES[parts[i].toLowerCase()];
    if (!mod) return null;
    if (!modifiers.includes(mod)) modifiers.push(mod);
  }
  const tail = parts[parts.length - 1];
  const lower = tail.toLowerCase();
  const named = NAMED_KEYS[lower];
  if (named) return { modifiers, key: named };
  if (/^f([1-9]|1[0-2])$/i.test(tail)) return { modifiers, key: tail.toUpperCase() };
  if (/^[a-z0-9.,/_-]$/i.test(tail)) return { modifiers, key: tail.toLowerCase() };
  return null;
}

export function parseComputerWaitMs(raw: string | undefined): number | null {
  const text = (raw ?? "").trim().toLowerCase();
  if (!text) return 500;
  const msMatch = /^(\d+(?:\.\d+)?)\s*(ms|s|sec|seconds?)?$/.exec(text);
  if (!msMatch) return null;
  const num = Number(msMatch[1]);
  if (!Number.isFinite(num) || num <= 0) return null;
  const ms = msMatch[2] && msMatch[2].startsWith("s") ? Math.round(num * 1000) : Math.round(num);
  return ms <= 10_000 ? ms : null;
}

export function computerStepIssue(step: { action?: string; target?: string; prompt?: string; options?: string }): StepIssue | null {
  const action = normalizeComputerAction(step.action || step.prompt);
  if (!action) return "prompt";
  if (action === "screenshot" || action === "windows") return null;
  if (action === "focus-window") return (step.target || step.prompt || "").trim() ? null : "target";
  if (action === "click" || action === "double-click" || action === "right-click" || action === "move") {
    return parseComputerCoordinates(step.target || step.prompt) ? null : "target";
  }
  if (action === "drag") return parseComputerDrag(step.target || step.prompt) ? null : "target";
  if (action === "scroll") return parseComputerScroll(step.prompt || step.target) ? null : "prompt";
  if (action === "type") {
    const text = step.prompt ?? "";
    return text.length > 0 && text.length <= 2000 ? null : "prompt";
  }
  if (action === "key") return validateKeyCombo(step.prompt || step.target) ? null : "prompt";
  if (action === "wait") return parseComputerWaitMs(step.prompt || step.target) !== null ? null : "prompt";
  return null;
}

export function describeComputerStep(step: { action?: string; target?: string; prompt?: string; options?: string }): string {
  const action = normalizeComputerAction(step.action || step.prompt);
  const surface = parseComputerSurface(step.options, step.target);
  if (!action) return step.action || step.prompt || "computer";
  const surfSuffix = surface === "desktop" ? "" : ` · ${surface}`;
  if (action === "screenshot") return `Screenshot${surfSuffix}`;
  if (action === "windows") return "Desktop windows";
  if (action === "focus-window") return `Focus window ${(step.target || step.prompt || "").trim()}`;
  if (action === "click" || action === "double-click" || action === "right-click" || action === "move") {
    const coords = parseComputerCoordinates(step.target || step.prompt);
    const label = action === "move" ? "Move cursor" : action === "double-click" ? "Double-click" : action === "right-click" ? "Right-click" : "Click";
    return `${label}${coords ? ` (${coords.x}, ${coords.y})` : ""}${surfSuffix}`;
  }
  if (action === "drag") {
    const drag = parseComputerDrag(step.target || step.prompt);
    return `Drag${drag ? ` (${drag.fromX},${drag.fromY} → ${drag.toX},${drag.toY})` : ""}${surfSuffix}`;
  }
  if (action === "scroll") return `Scroll ${(step.prompt || step.target || "").trim()}${surfSuffix}`;
  if (action === "type") {
    const text = (step.prompt ?? "").replace(/\s+/g, " ").trim();
    const preview = text.length > 36 ? `${text.slice(0, 35)}…` : text;
    return `Type "${preview}"${surfSuffix}`;
  }
  if (action === "key") return `Key ${(step.prompt || step.target || "").trim()}${surfSuffix}`;
  return `Wait ${(step.prompt || step.target || "500ms").trim()}`;
}
