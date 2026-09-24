import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";

export function TerminalView({ ptyId }: { ptyId: string }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const node = ref.current;
    const api = window.forgedesk;
    if (!node || !api) return;
    const term = new Terminal({
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
      fontSize: 13,
      cursorBlink: true,
      scrollback: 5000,
      theme: {
        background: "#09090b",
        foreground: "#e4e4e7",
        cursor: "#f59e0b",
        selectionBackground: "#3f3f46",
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(node);
    fit.fit();

    let disposed = false;
    let ready = false;
    let seen = 0;
    const queue: { seq: number; data: string }[] = [];
    const apply = (seq: number, data: string) => {
      if (seq <= seen) return;
      seen = seq;
      term.write(data);
    };
    const off = api.onPtyData((event) => {
      if (event.ptyId !== ptyId) return;
      if (!ready) queue.push(event);
      else apply(event.seq, event.data);
    });
    const input = term.onData((data) => {
      void api.writePty(ptyId, data);
    });
    const resize = () => {
      fit.fit();
      void api.resizePty(ptyId, term.cols, term.rows);
    };
    const observer = new ResizeObserver(() => resize());
    observer.observe(node);
    void api.ptySnapshot(ptyId).then((snap) => {
      if (disposed) return;
      term.write(snap.text);
      seen = snap.seq;
      ready = true;
      for (const event of queue) apply(event.seq, event.data);
      resize();
    });

    return () => {
      disposed = true;
      off();
      input.dispose();
      observer.disconnect();
      term.dispose();
    };
  }, [ptyId]);

  return <div ref={ref} className="fd-xterm" />;
}
