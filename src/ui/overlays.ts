// Everything that floats over the app and closes on Escape (menus, sheets, dialogs, the
// switcher, Maestro's bar) goes on one stack. Only the top one hears Escape, so Esc on a menu
// inside a sheet closes the menu and leaves the sheet open. Tab stays inside the top dialog, and
// while anything is on the stack the views' own shortcuts wait, so a key can't open a pane
// behind a dialog.

export interface Overlay {
  /** What Escape does while this one is on top. */
  close: () => void;
  /** Its element, for Tab and for taking focus back when the one above it closes. */
  node?: () => HTMLElement | null;
  /** Keep Tab inside it (a dialog). A menu lets Tab go. */
  trap?: boolean;
}

const stack: Overlay[] = [];
let listening = false;

/** Put an overlay on top. The function it returns takes it off again. */
export function pushOverlay(overlay: Overlay): () => void {
  stack.push(overlay);
  listen();
  return () => {
    const at = stack.lastIndexOf(overlay);
    if (at >= 0) stack.splice(at, 1);
  };
}

export function topOverlay(): Overlay | undefined {
  return stack[stack.length - 1];
}

/** True while a menu, dialog or other overlay is open; the views' shortcuts wait until it closes. */
export function overlayOpen(): boolean {
  return stack.length > 0;
}

type EscapeEvent = Pick<KeyboardEvent, "key" | "defaultPrevented" | "isComposing" | "preventDefault" | "stopPropagation"> & {
  target: EventTarget | { closest?: (selector: string) => unknown } | null;
};

/** Whether a key was typed into a terminal: its program gets it, not the window. */
function inTerminal(target: EscapeEvent["target"]): boolean {
  const closest = (target as { closest?: (selector: string) => unknown } | null)?.closest;
  return typeof closest === "function" && Boolean(closest.call(target, ".xterm"));
}

/**
 * Escape closes the top overlay and nothing under it. False when it wasn't one for us. In a
 * terminal (a task sheet's live CLI) Escape is the program's: Claude Code stops on it. The way
 * out is then the overlay's close button, or Escape once focus has left the terminal.
 */
export function escapeTop(event: EscapeEvent): boolean {
  // Taken already: dictation drops its words on Escape (voice.tsx), the tour closes itself.
  if (event.key !== "Escape" || event.defaultPrevented || event.isComposing) return false;
  if (inTerminal(event.target)) return false;
  const top = topOverlay();
  if (!top) return false;
  event.preventDefault();
  event.stopPropagation();
  top.close();
  return true;
}

const FOCUSABLE = 'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';

/** Tab and Shift+Tab go round the top dialog instead of out to the page behind it. */
function trapTab(event: KeyboardEvent): void {
  if (event.key !== "Tab" || event.defaultPrevented || event.ctrlKey || event.altKey || event.metaKey) return;
  const top = topOverlay();
  const node = top?.trap ? top.node?.() : null;
  if (!node) return;
  const target = event.target instanceof Element ? event.target : null;
  // A terminal inside the dialog keeps Tab for its program.
  if (target?.closest(".xterm") && node.contains(target)) return;
  const items = [...node.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((item) => item.getClientRects().length > 0);
  if (!items.length) return;
  const first = items[0];
  const last = items[items.length - 1];
  const active = document.activeElement;
  if (!active || !node.contains(active)) {
    event.preventDefault();
    (event.shiftKey ? last : first).focus();
  } else if (event.shiftKey && (active === first || active === node)) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && active === last) {
    event.preventDefault();
    first.focus();
  }
}

/**
 * Where focus goes when an overlay closes: back to what had it before it opened (the button, the
 * terminal), or else the overlay now on top. Focus that something else took on purpose stays put.
 */
export function returnFocus(before: HTMLElement | null, node: HTMLElement | null): void {
  const lost = () => !document.activeElement || document.activeElement === document.body;
  const active = document.activeElement;
  if (!lost() && !(active && node?.contains(active))) return;
  if (before?.isConnected) before.focus({ preventScroll: true });
  if (lost()) topOverlay()?.node?.()?.focus({ preventScroll: true });
}

function listen(): void {
  if (listening || typeof document === "undefined") return;
  listening = true;
  // On the document, so the window's own capture listeners (dictation, the tour) go first, and
  // still before anything inside the overlay sees the key.
  document.addEventListener("keydown", escapeTop, true);
  // Bubbling, so a control inside that uses Tab itself can claim it first.
  document.addEventListener("keydown", trapTab);
}
