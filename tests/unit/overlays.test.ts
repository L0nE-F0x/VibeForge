import { afterEach, describe, expect, it } from "vitest";
import { escapeTop, overlayOpen, pushOverlay, topOverlay } from "../../src/ui/overlays.js";
import { confirmSlot } from "../../src/ui/state.js";

/** A keydown as the overlay stack sees it, recording what was done to it. */
function keydown(key: string, init: { shiftKey?: boolean; defaultPrevented?: boolean; isComposing?: boolean; target?: { closest: (selector: string) => unknown } } = {}) {
  const event = {
    key,
    shiftKey: init.shiftKey ?? false,
    target: init.target ?? null,
    defaultPrevented: init.defaultPrevented ?? false,
    isComposing: init.isComposing ?? false,
    stopped: false,
    preventDefault() {
      event.defaultPrevented = true;
    },
    stopPropagation() {
      event.stopped = true;
    },
  };
  return event;
}

describe("the overlay stack", () => {
  const pops: Array<() => void> = [];
  const open = (closed: string[], name: string) => {
    const pop = pushOverlay({ close: () => closed.push(name) });
    pops.push(pop);
    return pop;
  };
  afterEach(() => {
    while (pops.length) pops.pop()?.();
  });

  it("closes only the top overlay on Escape: a menu inside a sheet leaves the sheet open", () => {
    const closed: string[] = [];
    open(closed, "sheet");
    const menu = open(closed, "menu");
    const event = keydown("Escape");
    expect(escapeTop(event)).toBe(true);
    expect(closed).toEqual(["menu"]);
    expect(event.defaultPrevented && event.stopped).toBe(true);
    // The menu goes away; the next Escape reaches the sheet.
    menu();
    escapeTop(keydown("Escape"));
    expect(closed).toEqual(["menu", "sheet"]);
  });

  it("puts a confirm over a sheet on top, so Escape on the confirm keeps the sheet", () => {
    const closed: string[] = [];
    open(closed, "task sheet");
    open(closed, "delete running task?");
    escapeTop(keydown("Escape"));
    expect(closed).toEqual(["delete running task?"]);
  });

  it("leaves keys alone that aren't its own or were taken already", () => {
    const closed: string[] = [];
    open(closed, "dialog");
    expect(escapeTop(keydown("Enter"))).toBe(false);
    // Dictation took this Escape to drop its words; the dialog stays.
    expect(escapeTop(keydown("Escape", { defaultPrevented: true }))).toBe(false);
    // Escape that ends an IME composition belongs to the field.
    expect(escapeTop(keydown("Escape", { isComposing: true }))).toBe(false);
    expect(closed).toEqual([]);
  });

  it("leaves Escape typed into a terminal to its program, and closes once focus is out of it", () => {
    const closed: string[] = [];
    open(closed, "task sheet");
    // A live CLI in the sheet: Claude Code stops on Escape, so the sheet must stay.
    const terminal = { closest: (selector: string) => (selector === ".xterm" ? {} : null) };
    const typed = keydown("Escape", { target: terminal });
    expect(escapeTop(typed)).toBe(false);
    expect(typed.defaultPrevented || typed.stopped).toBe(false);
    expect(closed).toEqual([]);
    // Focus on the sheet's own controls: Escape closes it as before.
    const button = { closest: () => null };
    expect(escapeTop(keydown("Escape", { target: button }))).toBe(true);
    expect(closed).toEqual(["task sheet"]);
  });

  it("closes the top overlay on Shift+Escape from inside a terminal, and keeps it from the CLI", () => {
    const closed: string[] = [];
    open(closed, "task sheet");
    const terminal = { closest: (selector: string) => (selector === ".xterm" ? {} : null) };
    const event = keydown("Escape", { shiftKey: true, target: terminal });
    expect(escapeTop(event)).toBe(true);
    expect(event.defaultPrevented && event.stopped).toBe(true);
    expect(closed).toEqual(["task sheet"]);
  });

  it("does nothing on Escape with nothing open, and says when something is", () => {
    expect(overlayOpen()).toBe(false);
    const event = keydown("Escape");
    expect(escapeTop(event)).toBe(false);
    expect(event.stopped).toBe(false);
    const closed: string[] = [];
    const pop = open(closed, "switcher");
    expect(overlayOpen()).toBe(true);
    pop();
    expect(overlayOpen()).toBe(false);
    expect(topOverlay()).toBeUndefined();
  });

  it("takes an overlay out from the middle when it closes first", () => {
    const closed: string[] = [];
    const lower = open(closed, "lower");
    open(closed, "upper");
    lower();
    escapeTop(keydown("Escape"));
    expect(closed).toEqual(["upper"]);
    lower();
    expect(overlayOpen()).toBe(true);
  });
});

describe("the confirm dialog", () => {
  it("answers the open question with no when a second one replaces it", async () => {
    const shown: Array<string | null> = [];
    const slot = confirmSlot((request) => shown.push(request?.title ?? null));
    const first = slot.ask({ title: "Close this terminal?" });
    const second = slot.ask({ title: "Remove the workspace?" });
    await expect(first).resolves.toBe(false);
    expect(shown).toEqual(["Close this terminal?", "Remove the workspace?"]);
    slot.settle(true);
    await expect(second).resolves.toBe(true);
    expect(shown.at(-1)).toBeNull();
  });

  it("settles once: a late settle with nothing open changes nothing", async () => {
    const slot = confirmSlot(() => undefined);
    const asked = slot.ask({ title: "Stop all?" });
    slot.settle(false);
    slot.settle(true);
    await expect(asked).resolves.toBe(false);
  });
});
