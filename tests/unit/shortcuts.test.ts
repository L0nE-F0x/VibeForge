import fs from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { isShortcut, runShortcut, shortcutKeys, SHORTCUTS, shortcutSheet, shortcutsFor, type KeyLike, type ShortcutId, type ShortcutScope } from "../../src/ui/shortcuts.js";
import { appShortcut } from "../../src/ui/terminal-keys.js";

const press = (key: string, mods: { ctrl?: boolean; shift?: boolean; alt?: boolean; meta?: boolean } = {}, code = "") => ({
  key,
  code,
  ctrlKey: Boolean(mods.ctrl),
  shiftKey: Boolean(mods.shift),
  altKey: Boolean(mods.alt),
  metaKey: Boolean(mods.meta),
});

/** A keydown as runShortcut sees it, recording whether it was taken. */
const keydown = (key: string, mods: { ctrl?: boolean; shift?: boolean; alt?: boolean } = {}, opts: { code?: string; repeat?: boolean } = {}) => {
  const event = { ...press(key, mods, opts.code ?? ""), repeat: Boolean(opts.repeat), taken: false, preventDefault: () => (event.taken = true) };
  return event;
};

/** Every key the app has a use for, and some it doesn't, with every mix of modifiers. */
function sweep(): Array<ReturnType<typeof press>> {
  const keys: Array<[string, string]> = [];
  for (const letter of "abcdefghijklmnopqrstuvwxyz") keys.push([letter, `Key${letter.toUpperCase()}`], [letter.toUpperCase(), `Key${letter.toUpperCase()}`]);
  for (const digit of "0123456789") keys.push([digit, `Digit${digit}`]);
  keys.push([",", "Comma"], ["<", "Comma"], ["/", "Slash"], ["?", "Slash"], [" ", "Space"]);
  for (const name of ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "Escape", "Enter", "Insert", "Tab", "F2"]) keys.push([name, name]);
  const events: Array<ReturnType<typeof press>> = [];
  for (const [key, code] of keys) for (let mods = 0; mods < 16; mods += 1) events.push(press(key, { ctrl: Boolean(mods & 1), shift: Boolean(mods & 2), alt: Boolean(mods & 4), meta: Boolean(mods & 8) }, code));
  return events;
}

/** Where each scope's keys are acted on. */
const HANDLERS: Record<ShortcutScope, string[]> = {
  app: ["src/ui/App.tsx"],
  code: ["src/ui/views/code/useCodeShortcuts.ts"],
  overlay: ["src/ui/overlays.ts"],
  terminal: ["src/ui/terminal-keys.ts", "src/ui/components/Terminal.tsx"],
  voice: ["src/ui/voice.tsx"],
  runs: ["src/ui/views/Runs.tsx"],
  form: ["src/ui/views/Agents.tsx"],
  toast: ["src/ui/state.tsx"],
  list: ["src/ui/components/SidePanel.tsx"],
  tour: ["src/ui/components/Tour.tsx"],
};

/** Every UI source file but the registry and the translations, whose sentences name keys in each language's words. */
function uiSources(dir = "src/ui"): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = `${dir}/${entry.name}`;
    if (entry.isDirectory()) return full === "src/ui/i18n" ? [] : uiSources(full);
    return /\.(ts|tsx)$/.test(entry.name) && full !== "src/ui/shortcuts.ts" ? [full] : [];
  });
}

describe("the shortcut registry", () => {
  it("names each shortcut once, with its keys or a gesture", () => {
    const ids = SHORTCUTS.map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const item of SHORTCUTS) {
      expect(Boolean(item.keys) !== Boolean(item.gesture), `${item.id} has keys or a gesture`).toBe(true);
      if (item.gesture) expect(item.chord, `${item.id} is a gesture`).toBeUndefined();
      // Keys without a chord only say what the same keys do elsewhere (Ctrl+C with nothing selected).
      if (item.keys && !item.chord) expect(SHORTCUTS.some((other) => other !== item && other.chord && other.keys === item.keys), `${item.id} shares its keys`).toBe(true);
    }
  });

  it("puts every shortcut on the sheet once, under its heading, in the registry's order", () => {
    const onSheet = SHORTCUTS.filter((item) => !item.offSheet);
    expect(onSheet.length).toBeGreaterThan(30);
    const sheet = shortcutSheet();
    expect(sheet.map((section) => section.group)).toEqual(["shortcuts.anywhere", "shortcuts.code", "shortcuts.terminals", "shortcuts.voice", "shortcuts.editing", "shortcuts.runs"]);
    expect(sheet.flatMap((section) => section.rows.map((row) => row.id))).toEqual(onSheet.map((item) => item.id));
    const row = sheet[0].rows.find((item) => item.id === "app.shortcuts");
    expect(row).toEqual({ id: "app.shortcuts", keys: "Ctrl+Shift+/", gesture: undefined, text: "shortcuts.list" });
    expect(fs.readFileSync("src/ui/components/Help.tsx", "utf8")).toContain("...shortcutSheet()");
  });

  it("has no keycaps written by hand outside it: tooltips, hints, the sheet and the tour all ask it", () => {
    const found: string[] = [];
    for (const file of uiSources()) {
      // Comments may name keys; only code is looked at.
      const code = fs.readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "$1");
      const keycaps = [
        /["'`](?:Ctrl|Alt|Shift|Super|Meta)\+/g,
        /\bkbd(?:=|:\s*)["'`]/g,
        /\b(?:kbd|hint|keys):\s*\[*\s*["'`](?:Esc|Enter|Space|[←→↑↓]|[A-Z])["'`]/g,
      ];
      for (const pattern of keycaps) for (const match of code.matchAll(pattern)) found.push(`${file}: ${code.slice(match.index, match.index + 40).split("\n")[0]}`);
    }
    expect(found).toEqual([]);
  });

  it("has every key on the sheet acted on where its scope says", () => {
    for (const item of SHORTCUTS) {
      if (!item.chord) continue;
      const files = HANDLERS[item.scope];
      expect(files, `${item.id}'s scope has a handler`).toBeDefined();
      const found = files.some((file) => fs.readFileSync(file, "utf8").includes(`"${item.id}"`));
      expect(found, `${item.id} is handled in ${files.join(" or ")}`).toBe(true);
    }
  });

  it("keeps what each key meant before it had a registry", () => {
    const cases: Array<[KeyLike, ShortcutId[]]> = [
      [press("k", { ctrl: true }), ["app.switcher"]],
      [press("K", { ctrl: true, shift: true }), ["app.switcher"]],
      [press("k", { ctrl: true, alt: true }), []],
      [press("3", { ctrl: true }, "Digit3"), ["app.views"]],
      [press("#", { ctrl: true, shift: true }, "Digit3"), []],
      [press("3", { alt: true }, "Digit3"), ["app.workspaces"]],
      [press("#", { alt: true, shift: true }, "Digit3"), []],
      [press(",", { ctrl: true }, "Comma"), ["app.settings"]],
      // While the tour is up, its own listener takes the arrows first, as it always did.
      [press("ArrowLeft", { alt: true }), ["app.back", "tour.back"]],
      [press("ArrowLeft", { alt: true, ctrl: true }), ["app.back", "tour.back"]],
      [press("ArrowRight", { alt: true }), ["app.forward", "tour.next"]],
      [press("O", { ctrl: true, shift: true }), ["app.orchestrator"]],
      [press("?", { ctrl: true, shift: true }, "Slash"), ["app.shortcuts"]],
      [press("B", { ctrl: true, shift: true }), ["app.panel"]],
      [press("I", { ctrl: true, shift: true }), ["app.devtools"]],
      [press("D", { ctrl: true, shift: true }), ["code.splitRight"]],
      [press("E", { ctrl: true, shift: true }), ["code.splitDown"]],
      [press("W", { ctrl: true, shift: true }), ["code.close"]],
      [press("M", { ctrl: true, shift: true }), ["code.maximize"]],
      [press("D", { ctrl: true, shift: true, alt: true }), []],
      [press("Escape"), ["overlay.close", "voice.cancel"]],
      [press("Escape", { shift: true }), ["overlay.close", "overlay.closeFromTerminal", "voice.cancel"]],
      [press("c", { ctrl: true }), ["terminal.copy"]],
      [press("v", { ctrl: true }), ["terminal.paste"]],
      [press("Enter", { ctrl: true, shift: true }), ["terminal.write", "tour.next"]],
      [press(" ", { ctrl: true, shift: true }, "Space"), ["voice.dictate"]],
      [press("s", { ctrl: true }), ["form.save"]],
      [press("z", { ctrl: true }), ["toast.undo"]],
      [press("Z", { ctrl: true, shift: true }), []],
      [press("j"), ["runs.next"]],
      [press("k"), ["runs.prev"]],
      // Caps Lock on: J and K stay letters to type.
      [press("J"), []],
      [press("ArrowDown"), ["list.move"]],
      [press("End"), ["list.move"]],
      [press("ArrowDown", { shift: true }), []],
    ];
    for (const [event, ids] of cases) expect(shortcutsFor(event), JSON.stringify(event)).toEqual(ids);
  });

  it("never gives one key to two of the window's listeners, so the order they run in can't matter", () => {
    const window: ShortcutScope[] = ["app", "code", "form", "toast", "runs", "list"];
    for (const event of sweep()) {
      const claimed = shortcutsFor(event).filter((id) => window.includes(SHORTCUTS.find((item) => item.id === id)!.scope));
      expect(claimed.length, `${JSON.stringify(event)}: ${claimed.join(", ")}`).toBeLessThanOrEqual(1);
    }
  });
});

describe("what a terminal lets through", () => {
  it("lets through only the window's keys the registry marks for it", () => {
    expect(appShortcut(press("K", { ctrl: true, shift: true }))).toBe(true);
    expect(appShortcut(press("?", { ctrl: true, shift: true }, "Slash"))).toBe(true);
    expect(appShortcut(press(",", { ctrl: true }))).toBe(true);
    // The program's: kill-line, word moves, an Alt+Ctrl+Shift chord, and keys taken before or by the terminal.
    for (const event of [
      press("k", { ctrl: true }),
      press("ArrowLeft", { alt: true }),
      press("ArrowRight", { alt: true }),
      press("B", { ctrl: true, shift: true, alt: true }),
      press("?", { ctrl: true, shift: true, alt: true }, "Slash"),
      press("Escape", { shift: true }),
      press(" ", { ctrl: true, shift: true }, "Space"),
      press("Enter", { ctrl: true, shift: true }),
      press("s", { ctrl: true }),
      press("z", { ctrl: true }),
    ])
      expect(appShortcut(event), JSON.stringify(event)).toBe(false);
  });

  it("never lets through a key nobody on the window acts on", () => {
    for (const event of sweep()) {
      if (!appShortcut(event)) continue;
      const owners = shortcutsFor(event).map((id) => SHORTCUTS.find((item) => item.id === id)!);
      expect(owners.some((item) => (item.scope === "app" || item.scope === "code") && item.terminal === "window"), JSON.stringify(event)).toBe(true);
    }
  });
});

describe("running shortcuts", () => {
  it("tries the actions in the order given and takes the key", () => {
    const order: string[] = [];
    const event = keydown("Escape");
    expect(runShortcut(event, { "voice.cancel": () => void order.push("voice"), "overlay.close": () => void order.push("overlay") }, () => false)).toBe(true);
    expect(runShortcut(keydown("Escape"), { "overlay.close": () => void order.push("overlay"), "voice.cancel": () => void order.push("voice") }, () => false)).toBe(true);
    expect(order).toEqual(["voice", "overlay"]);
    expect(event.taken).toBe(true);
  });

  it("leaves a key alone when its action says it doesn't apply, and tries nothing after it", () => {
    const later = vi.fn();
    const event = keydown("5", { ctrl: true });
    expect(runShortcut(event, { "app.views": () => false, "app.settings": later }, () => false)).toBe(false);
    expect(event.taken).toBe(false);
    expect(later).not.toHaveBeenCalled();
  });

  it("keeps Code's pane keys waiting under a menu or dialog, and runs a held key once", () => {
    const split = vi.fn();
    const under = keydown("D", { ctrl: true, shift: true });
    expect(runShortcut(under, { "code.splitRight": split }, () => true)).toBe(false);
    expect(under.taken).toBe(false);
    const held = keydown("D", { ctrl: true, shift: true }, { repeat: true });
    expect(runShortcut(held, { "code.splitRight": split }, () => false)).toBe(true);
    expect(held.taken).toBe(true);
    expect(split).not.toHaveBeenCalled();
    runShortcut(keydown("D", { ctrl: true, shift: true }), { "code.splitRight": split }, () => false);
    expect(split).toHaveBeenCalledTimes(1);
  });

  it("keeps navigation working over menus and dialogs", () => {
    const open = vi.fn();
    expect(runShortcut(keydown("k", { ctrl: true }), { "app.switcher": open }, () => true)).toBe(true);
    expect(open).toHaveBeenCalledTimes(1);
  });

  it("gives tooltips the keys the sheet shows", () => {
    expect(shortcutKeys("code.splitRight")).toBe("Ctrl+Shift+D");
    expect(shortcutKeys("voice.dictate")).toBe("Ctrl+Shift+Space");
    expect(isShortcut("voice.dictate", press(" ", { ctrl: true, shift: true }, "Space"))).toBe(true);
  });
});
