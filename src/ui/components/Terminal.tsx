import { FitAddon } from "@xterm/addon-fit";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal as XTerm, type ITerminalOptions } from "@xterm/xterm";
import { ChevronDown, ChevronUp, X } from "lucide-react";
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState, type DragEvent, type RefObject } from "react";
import { shellQuote } from "../../shared/text.js";
import { call, onPtyData, onPtyExit, pathForFile, useSettings } from "../api.js";
import { appShortcut, clipboardKey, isWebLink } from "../terminal-keys.js";
import { mayTakeFocus } from "../overlays.js";
import { hidePointerTip, showPointerTip } from "./Tooltip.js";
import { Button, Input } from "./ui.js";
import { isShortcut } from "../shortcuts.js";
import { notePtyInput } from "../voice.js";
import { usePalette, xtermTheme } from "../theme.js";
import { t as translate, useT } from "../i18n/index.js";
import { WebglPool, type GlUser } from "../webgl-pool.js";

export const PATH_MIME = "application/x-vibeforge-path";
/** Under Chromium's limit of WebGL contexts per page; the other terminals draw with the DOM. */
const webgl = new WebglPool(10);
/**
 * How long a terminal's size has to stay put before the program hears about it. Dragging a divider
 * or the window fits the terminal every frame; a CLI told each of those sizes redraws each time.
 */
const RESIZE_SETTLE_MS = 100;

/**
 * OSC 8 links show text that can differ from where they go ("github.com/…" pointing elsewhere), so
 * the real address shows in a tooltip while the pointer is on one, before anyone clicks it.
 */
const linkHover = {
  hover: (event: MouseEvent, uri: string) => showPointerTip(uri, event.clientX, event.clientY),
  leave: () => hidePointerTip(),
};

export interface TerminalHandle {
  focus(): void;
  /** Insert text the way a paste would (bracketed when the program asked for it). */
  paste(text: string): void;
  /** The text selected in the terminal, or "". */
  selection(): string;
}

/**
 * Roughly how many cells fit in an element, so a CLI starts at the right size instead of
 * drawing at 120x32 and being resized a moment later. The terminal fits exactly once mounted.
 */
export function estimateTermSize(element: HTMLElement | null, fontSize: number, reservedHeight = 0): { cols?: number; rows?: number } {
  if (!element) return {};
  const rect = element.getBoundingClientRect();
  const width = rect.width - 12;
  const height = rect.height - reservedHeight - 8;
  if (width < 100 || height < 60) return {};
  return {
    cols: Math.max(20, Math.floor(width / (fontSize * 0.6))),
    rows: Math.max(6, Math.floor(height / Math.ceil(fontSize * 1.32 * 1.18))),
  };
}

function baseOptions(fontFamily: string, fontSize: number): ITerminalOptions {
  return {
    fontFamily: `"${fontFamily}", "JetBrainsMono Nerd Font", "JetBrains Mono", monospace`,
    fontSize,
    lineHeight: 1.18,
    cursorBlink: true,
    cursorStyle: "bar",
    cursorInactiveStyle: "outline",
    scrollback: 10000,
    allowProposedApi: true,
    drawBoldTextInBrightColors: false,
    minimumContrastRatio: 1,
    rightClickSelectsWord: false,
    smoothScrollDuration: 0,
    customGlyphs: true,
    rescaleOverlappingGlyphs: true,
  };
}

/** The terminal's seat in the WebGL pool: it draws with WebGL while it holds a slot. */
function webglSeat(term: XTerm): GlUser {
  let addon: WebglAddon | null = null;
  const seat: GlUser = {
    attach() {
      try {
        const next = new WebglAddon();
        // The GPU dropped the context (a reset, or too many): back to the DOM renderer, and the
        // slot goes to another terminal.
        next.onContextLoss(() => {
          if (addon !== next) return;
          seat.detach();
          webgl.lost(seat);
        });
        term.loadAddon(next);
        addon = next;
        return true;
      } catch {
        return false;
      }
    },
    detach() {
      const current = addon;
      addon = null;
      try {
        current?.dispose();
      } catch {
        /* already gone */
      }
    },
  };
  return seat;
}

function useFileDrop(insert: (text: string) => void) {
  const [dragging, setDragging] = useState(false);
  return {
    dragging,
    handlers: {
      onDragOver(event: DragEvent) {
        const types = event.dataTransfer.types;
        if (!types.includes("Files") && !types.includes(PATH_MIME)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
        setDragging(true);
      },
      onDragLeave(event: DragEvent) {
        if (event.currentTarget.contains(event.relatedTarget as Node)) return;
        setDragging(false);
      },
      onDrop(event: DragEvent) {
        setDragging(false);
        const paths: string[] = [];
        const custom = event.dataTransfer.getData(PATH_MIME);
        if (custom) paths.push(custom);
        for (const file of Array.from(event.dataTransfer.files)) {
          const found = pathForFile(file);
          if (found) paths.push(found);
        }
        if (!paths.length) return;
        event.preventDefault();
        insert(`${paths.map(shellQuote).join(" ")} `);
      },
    },
  };
}

interface TermMatch {
  row: number;
  col: number;
  length: number;
}

function findBufferMatches(term: XTerm, needle: string): TermMatch[] {
  const clean = needle.toLowerCase();
  if (!clean) return [];
  const buf = term.buffer.active;
  const matches: TermMatch[] = [];
  for (let row = 0; row < buf.length; row += 1) {
    const line = buf.getLine(row)?.translateToString(true);
    if (!line) continue;
    const lower = line.toLowerCase();
    let from = 0;
    while (from <= lower.length - clean.length) {
      const col = lower.indexOf(clean, from);
      if (col < 0) break;
      matches.push({ row, col, length: clean.length });
      from = col + clean.length;
    }
  }
  return matches;
}

function useTerminalSearch(termRef: RefObject<XTerm | null>) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [matchCount, setMatchCount] = useState(0);
  const [matchIndex, setMatchIndex] = useState(-1);
  const matchesRef = useRef<TermMatch[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);

  const selectAt = useCallback(
    (index: number) => {
      const term = termRef.current;
      const list = matchesRef.current;
      if (!term || !list.length) return;
      const wrapped = ((index % list.length) + list.length) % list.length;
      const hit = list[wrapped];
      term.select(hit.col, hit.row, hit.length);
      term.scrollToLine(Math.max(0, hit.row - Math.floor(term.rows / 2)));
      setMatchIndex(wrapped);
    },
    [termRef],
  );

  useEffect(() => {
    const term = termRef.current;
    if (!open || !term) {
      matchesRef.current = [];
      setMatchCount(0);
      setMatchIndex(-1);
      return;
    }
    const list = findBufferMatches(term, query);
    matchesRef.current = list;
    setMatchCount(list.length);
    if (list.length) selectAt(list.length - 1);
    else {
      term.clearSelection();
      setMatchIndex(-1);
    }
  }, [open, query, termRef, selectAt]);

  const openFind = useCallback(() => {
    if (!open) {
      const sel = termRef.current?.getSelection() ?? "";
      if (sel && !sel.includes("\n") && sel.length <= 120) setQuery(sel);
    }
    setOpen(true);
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
  }, [open, termRef]);

  const closeFind = useCallback(() => {
    setOpen(false);
    termRef.current?.clearSelection();
    termRef.current?.focus();
  }, [termRef]);

  const step = useCallback(
    (delta: -1 | 1) => {
      if (!matchesRef.current.length) return;
      selectAt(matchIndex + delta);
    },
    [matchIndex, selectAt],
  );

  return { open, query, setQuery, matchCount, matchIndex, inputRef, openFind, closeFind, step };
}

function TerminalSearchBar({ search }: { search: ReturnType<typeof useTerminalSearch> }) {
  const t = useT();
  if (!search.open) return null;
  const countText = search.query ? (search.matchCount ? `${search.matchIndex + 1}/${search.matchCount}` : t("terminal.findNone")) : "";
  return (
    <div className="term-find" onMouseDown={(event) => event.stopPropagation()}>
      <Input
        ref={search.inputRef}
        value={search.query}
        placeholder={t("terminal.findPlaceholder")}
        aria-label={t("terminal.findPlaceholder")}
        onChange={(event) => search.setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing || event.keyCode === 229) return;
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            search.closeFind();
          } else if (event.key === "Enter") {
            event.preventDefault();
            search.step(event.shiftKey ? -1 : 1);
          }
        }}
      />
      {countText && <span className="term-find-count">{countText}</span>}
      <Button size="sm" variant="ghost" icon={ChevronUp} disabled={!search.matchCount} tip={t("terminal.findPrev")} onClick={() => search.step(-1)} />
      <Button size="sm" variant="ghost" icon={ChevronDown} disabled={!search.matchCount} tip={t("terminal.findNext")} onClick={() => search.step(1)} />
      <Button size="sm" variant="ghost" icon={X} tip={t("common.close")} onClick={search.closeFind} />
    </div>
  );
}

interface LiveProps {
  ptyId: string;
  /** Hidden terminals skip fitting until they are shown again. */
  active?: boolean;
  autoFocus?: boolean;
  onExit?: (info: { exitCode: number | null; signal: number | null }) => void;
  onFocus?: () => void;
  /** An http(s) link was clicked. When omitted, the link opens in the system browser. */
  onLink?: (url: string) => void;
  /** Ctrl+Shift+Enter: open a box for a longer message. Without it the key reaches the program. */
  onCompose?: () => void;
  /** Everything sent to the program from the keyboard, as it goes. */
  onInput?: (data: string) => void;
}

/** A terminal attached to a live PTY in the host. */
export const LiveTerminal = forwardRef<TerminalHandle, LiveProps>(function LiveTerminal({ ptyId, active = true, autoFocus, onExit, onFocus, onLink, onCompose, onInput }, ref) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const seatRef = useRef<GlUser | null>(null);
  const activeRef = useRef(active);
  const onExitRef = useRef(onExit);
  const onFocusRef = useRef(onFocus);
  const onLinkRef = useRef(onLink);
  const onComposeRef = useRef(onCompose);
  onComposeRef.current = onCompose;
  const onInputRef = useRef(onInput);
  onInputRef.current = onInput;
  onExitRef.current = onExit;
  onFocusRef.current = onFocus;
  onLinkRef.current = onLink;
  activeRef.current = active;
  const settings = useSettings().data;
  const palette = usePalette();
  const fontFamily = settings?.terminalFontFamily ?? "JetBrainsMono Nerd Font";
  const fontSize = settings?.terminalFontSize ?? 13;
  const passthrough = settings?.terminalPassthrough ?? false;
  const optionsRef = useRef({ fontFamily, fontSize, palette, passthrough });
  optionsRef.current = { fontFamily, fontSize, palette, passthrough };
  const [ended, setEnded] = useState<string | null>(null);
  const search = useTerminalSearch(termRef);
  const openFindRef = useRef(search.openFind);
  openFindRef.current = search.openFind;
  /** Fit the terminal to its box and tell the program its size once it settles. */
  const refitRef = useRef<() => void>(() => undefined);

  useImperativeHandle(ref, () => ({
    focus: () => termRef.current?.focus(),
    paste: (text: string) => {
      termRef.current?.paste(text);
      termRef.current?.focus();
    },
    selection: () => termRef.current?.getSelection() ?? "",
  }));

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let disposed = false;
    const { fontFamily: family, fontSize: size, palette: initialPalette } = optionsRef.current;
    // Typed-out addresses (the web-links addon) and OSC 8 hyperlinks (Claude Code, gh and compilers
    // print them) open the same way: http(s) only, in the workspace's browser or the system one.
    const openLink = (uri: string) => {
      if (!isWebLink(uri)) return;
      const open = onLinkRef.current;
      if (open) open(uri);
      else void call("app.openExternal", uri);
    };
    const term = new XTerm({ ...baseOptions(family, size), theme: xtermTheme(initialPalette), linkHandler: { activate: (_event, uri) => openLink(uri), ...linkHover } });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new Unicode11Addon());
    term.unicode.activeVersion = "11";
    term.loadAddon(new WebLinksAddon((_event, uri) => openLink(uri)));
    term.open(host);
    const seat = webglSeat(term);
    seatRef.current = seat;
    webgl.add(seat, activeRef.current);
    termRef.current = term;
    fitRef.current = fit;

    let lastCols = 0;
    let lastRows = 0;
    let frame = 0;
    let settle = 0;
    // The terminal follows its box every frame; the program hears the size once it stops changing.
    const tellSize = () => {
      window.clearTimeout(settle);
      settle = window.setTimeout(() => {
        if (disposed || (term.cols === lastCols && term.rows === lastRows)) return;
        lastCols = term.cols;
        lastRows = term.rows;
        void call("pty.resize", ptyId, term.cols, term.rows).catch(() => undefined);
      }, RESIZE_SETTLE_MS);
    };
    const refit = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (disposed || !activeRef.current || host.offsetWidth < 20 || host.offsetHeight < 20) return;
        try {
          fit.fit();
        } catch {
          return;
        }
        tellSize();
      });
    };
    refitRef.current = refit;
    const observer = new ResizeObserver(refit);
    observer.observe(host);

    term.attachCustomKeyEventHandler((event) => {
      if (appShortcut(event, optionsRef.current.passthrough)) return false;
      if (isShortcut("terminal.find", event)) {
        if (event.type === "keydown") {
          event.preventDefault();
          openFindRef.current();
        }
        return false;
      }
      if (onComposeRef.current && isShortcut("terminal.write", event)) {
        if (event.type === "keydown") {
          event.preventDefault();
          onComposeRef.current();
        }
        return false;
      }
      if (event.type !== "keydown") return true;
      const action = clipboardKey(event, term.hasSelection(), optionsRef.current.passthrough);
      if (!action) return true;
      event.preventDefault();
      if (action === "copy") {
        const selection = term.getSelection();
        if (selection) void call("app.copyText", selection).catch(() => undefined);
        // Cleared, so the next Ctrl+C interrupts again.
        term.clearSelection();
      } else {
        void call("app.clipboard")
          .then(({ text, image }) => {
            if (text) term.paste(text);
            // Only an image: Claude Code reads it itself when it sees Ctrl+V.
            else if (image && action === "paste-or-pass") void call("pty.write", ptyId, "\x16");
          })
          .catch(() => undefined);
      }
      return false;
    });
    const input = term.onData((data) => {
      notePtyInput(ptyId, data);
      onInputRef.current?.(data);
      void call("pty.write", ptyId, data).catch(() => undefined);
    });
    const binary = term.onBinary((data) => void call("pty.write", ptyId, data).catch(() => undefined));
    const focusSub = term.textarea ? (() => {
      const handler = () => {
        webgl.touch(seat);
        onFocusRef.current?.();
      };
      term.textarea!.addEventListener("focus", handler);
      return () => term.textarea?.removeEventListener("focus", handler);
    })() : () => undefined;

    // Buffer live output until the snapshot is on screen, then replay only what came after it.
    let seen = -1;
    const queue: Array<{ data: string; first: number; seq: number }> = [];
    const offData = onPtyData(ptyId, (event) => {
      if (seen < 0) {
        queue.push(event);
        return;
      }
      if (event.seq <= seen) return;
      seen = event.seq;
      term.write(event.data);
    });
    const offExit = onPtyExit(ptyId, (info) => {
      if (disposed) return;
      const how = info.signal ? translate("pane.exitSignal", { signal: info.signal }) : translate("pane.exitCode", { code: info.exitCode ?? "?" });
      term.write(`\r\n\x1b[2m[${how}]\x1b[0m\r\n`);
      setEnded(how);
      onExitRef.current?.(info);
    });

    void document.fonts
      .load(`${size}px "${family}"`)
      .catch(() => undefined)
      .then(() => {
        if (disposed) return;
        term.options.fontFamily = baseOptions(family, size).fontFamily;
        return call("pty.snapshot", ptyId);
      })
      .then((snap) => {
        if (disposed || !snap) return;
        if (snap.ansi) term.write(snap.ansi);
        if (!snap.alive) {
          setEnded("ended");
          seen = Number.MAX_SAFE_INTEGER;
          return;
        }
        seen = snap.seq;
        for (const event of queue) {
          if (event.seq <= seen) continue;
          seen = event.seq;
          term.write(event.data);
        }
        queue.length = 0;
        refit();
        if (autoFocus && mayTakeFocus(host)) term.focus();
      })
      .catch(() => {
        if (!disposed) setEnded("ended");
      });

    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      window.clearTimeout(settle);
      refitRef.current = () => undefined;
      observer.disconnect();
      offData();
      offExit();
      input.dispose();
      binary.dispose();
      focusSub();
      webgl.remove(seat);
      seatRef.current = null;
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
    // The terminal belongs to one PTY; option changes are applied by the effects below.
  }, [ptyId]);

  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.options.theme = xtermTheme(palette);
  }, [palette]);

  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    const next = baseOptions(fontFamily, fontSize);
    term.options.fontFamily = next.fontFamily;
    term.options.fontSize = fontSize;
    // A new font size changes how many cells fit: the program hears the new size too.
    refitRef.current();
  }, [fontFamily, fontSize]);

  // On screen it asks for a WebGL slot; hidden, it gives its slot up once one on screen needs it.
  useEffect(() => {
    if (seatRef.current) webgl.show(seatRef.current, active);
  }, [active]);

  useEffect(() => {
    if (!active) return;
    const term = termRef.current;
    const fit = fitRef.current;
    if (!term || !fit) return;
    const frame = requestAnimationFrame(() => {
      try {
        fit.fit();
        void call("pty.resize", ptyId, term.cols, term.rows).catch(() => undefined);
      } catch {
        /* not laid out yet */
      }
      if (autoFocus && mayTakeFocus(hostRef.current)) term.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [active, autoFocus, ptyId]);

  const drop = useFileDrop((text) => {
    termRef.current?.paste(text);
    termRef.current?.focus();
  });

  return (
    <div
      className={`term${drop.dragging ? " drop-target" : ""}`}
      {...drop.handlers}
      data-ended={ended ?? undefined}
      onKeyDown={(event) => {
        if (isShortcut("terminal.find", event)) {
          event.preventDefault();
          event.stopPropagation();
          search.openFind();
        }
      }}
    >
      <div ref={hostRef} className="term-host" />
      <TerminalSearchBar search={search} />
    </div>
  );
});

/** A read-only terminal that replays a finished run's final screen. */
export function ReplayTerminal({ ansi, emptyText: given }: { ansi: string; emptyText?: string }) {
  const t = useT();
  const emptyText = given ?? t("run.noScreen");
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm | null>(null);
  const settings = useSettings().data;
  const palette = usePalette();
  const family = settings?.terminalFontFamily ?? "JetBrainsMono Nerd Font";
  const size = settings?.terminalFontSize ?? 13;
  const search = useTerminalSearch(termRef);
  const openFindRef = useRef(search.openFind);
  openFindRef.current = search.openFind;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let disposed = false;
    const openLink = (uri: string) => {
      if (isWebLink(uri)) void call("app.openExternal", uri);
    };
    const term = new XTerm({ ...baseOptions(family, size), cursorBlink: false, disableStdin: true, theme: xtermTheme(palette), linkHandler: { activate: (_event, uri) => openLink(uri), ...linkHover } });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new Unicode11Addon());
    term.unicode.activeVersion = "11";
    term.loadAddon(new WebLinksAddon((_event, uri) => openLink(uri)));
    term.open(host);
    termRef.current = term;
    // Nothing here goes to a program, so the copy keys copy and every other key goes on to the
    // window: J/K, Ctrl+K and the view keys work over a finished run's screen as anywhere else.
    // Even read-only, xterm would otherwise swallow any key that types a byte.
    term.attachCustomKeyEventHandler((event) => {
      if (isShortcut("terminal.find", event)) {
        if (event.type === "keydown") {
          event.preventDefault();
          openFindRef.current();
        }
        return false;
      }
      if (event.shiftKey && /^(PageUp|PageDown|Home|End)$/.test(event.key)) return true;
      if (event.type === "keydown" && clipboardKey(event, term.hasSelection()) === "copy") {
        event.preventDefault();
        const selection = term.getSelection();
        if (selection) void call("app.copyText", selection).catch(() => undefined);
      }
      return false;
    });
    const doFit = () => {
      if (disposed || host.offsetWidth < 20) return;
      try {
        fit.fit();
      } catch {
        /* hidden */
      }
    };
    doFit();
    term.write(ansi || `\x1b[2m${emptyText}\x1b[0m`, () => {
      // A screen replaced mid-write (a run that just ended) is already disposed: xterm then throws
      // on scrollToBottom, found by e2e/task-copy.e2e.ts.
      if (disposed) return;
      term.write("\x1b[?25l");
      term.scrollToBottom();
    });
    const observer = new ResizeObserver(() => requestAnimationFrame(doFit));
    observer.observe(host);
    return () => {
      disposed = true;
      observer.disconnect();
      term.dispose();
      termRef.current = null;
    };
    // Re-created when the content changes; palette and font are applied below.
  }, [ansi, emptyText]);

  useEffect(() => {
    if (termRef.current) termRef.current.options.theme = xtermTheme(palette);
  }, [palette]);

  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.options.fontSize = size;
    term.options.fontFamily = baseOptions(family, size).fontFamily;
  }, [family, size]);

  return (
    <div
      className="term replay"
      onKeyDown={(event) => {
        if (isShortcut("terminal.find", event)) {
          event.preventDefault();
          event.stopPropagation();
          search.openFind();
        }
      }}
    >
      <div ref={hostRef} className="term-host" />
      <TerminalSearchBar search={search} />
    </div>
  );
}
