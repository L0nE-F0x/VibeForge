import { FitAddon } from "@xterm/addon-fit";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal as XTerm, type ITerminalOptions } from "@xterm/xterm";
import { forwardRef, useEffect, useImperativeHandle, useRef, useState, type DragEvent } from "react";
import { shellQuote } from "../../shared/text.js";
import { call, onPtyData, onPtyExit, pathForFile, useSettings } from "../api.js";
import { appShortcut, clipboardKey, isWebLink } from "../terminal-keys.js";
import { mayTakeFocus } from "../overlays.js";
import { isShortcut } from "../shortcuts.js";
import { notePtyInput } from "../voice.js";
import { usePalette, xtermTheme } from "../theme.js";
import { t as translate, useT } from "../i18n/index.js";
import { WebglPool, type GlUser } from "../webgl-pool.js";

export const PATH_MIME = "application/x-vibeforge-path";
/** Under Chromium's limit of WebGL contexts per page; the other terminals draw with the DOM. */
const webgl = new WebglPool(10);

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
}

/** A terminal attached to a live PTY in the host. */
export const LiveTerminal = forwardRef<TerminalHandle, LiveProps>(function LiveTerminal({ ptyId, active = true, autoFocus, onExit, onFocus, onLink, onCompose }, ref) {
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
  onExitRef.current = onExit;
  onFocusRef.current = onFocus;
  onLinkRef.current = onLink;
  activeRef.current = active;
  const settings = useSettings().data;
  const palette = usePalette();
  const fontFamily = settings?.terminalFontFamily ?? "JetBrainsMono Nerd Font";
  const fontSize = settings?.terminalFontSize ?? 13;
  const optionsRef = useRef({ fontFamily, fontSize, palette });
  optionsRef.current = { fontFamily, fontSize, palette };
  const [ended, setEnded] = useState<string | null>(null);

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
    const term = new XTerm({ ...baseOptions(family, size), theme: xtermTheme(initialPalette), linkHandler: { activate: (_event, uri) => openLink(uri) } });
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
    const refit = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (disposed || !activeRef.current || host.offsetWidth < 20 || host.offsetHeight < 20) return;
        try {
          fit.fit();
        } catch {
          return;
        }
        if (term.cols !== lastCols || term.rows !== lastRows) {
          lastCols = term.cols;
          lastRows = term.rows;
          void call("pty.resize", ptyId, term.cols, term.rows).catch(() => undefined);
        }
      });
    };
    const observer = new ResizeObserver(refit);
    observer.observe(host);

    term.attachCustomKeyEventHandler((event) => {
      if (appShortcut(event)) return false;
      if (onComposeRef.current && isShortcut("terminal.write", event)) {
        if (event.type === "keydown") {
          event.preventDefault();
          onComposeRef.current();
        }
        return false;
      }
      if (event.type !== "keydown") return true;
      const action = clipboardKey(event, term.hasSelection());
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
        if (!snap.alive) {
          setEnded("ended");
          seen = Number.MAX_SAFE_INTEGER;
          return;
        }
        term.write(snap.ansi);
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
    try {
      fitRef.current?.fit();
    } catch {
      /* hidden */
    }
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
    <div className={`term${drop.dragging ? " drop-target" : ""}`} {...drop.handlers} data-ended={ended ?? undefined}>
      <div ref={hostRef} className="term-host" />
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

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let disposed = false;
    const openLink = (uri: string) => {
      if (isWebLink(uri)) void call("app.openExternal", uri);
    };
    const term = new XTerm({ ...baseOptions(family, size), cursorBlink: false, disableStdin: true, theme: xtermTheme(palette), linkHandler: { activate: (_event, uri) => openLink(uri) } });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new Unicode11Addon());
    term.unicode.activeVersion = "11";
    term.loadAddon(new WebLinksAddon((_event, uri) => openLink(uri)));
    term.open(host);
    termRef.current = term;
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
    <div className="term">
      <div ref={hostRef} className="term-host" />
    </div>
  );
}
