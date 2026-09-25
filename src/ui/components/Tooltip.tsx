import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { placeTip, type Box, type Side } from "../floating.js";
import { useDockArea, useLayer } from "../state.js";

// One tooltip for the whole app. Any element with `data-tip` gets it; `data-tip-kbd` adds
// keycaps ("Ctrl+1") and `data-tip-side` picks a side (top, bottom, left, right). It keeps
// clear of the browser dock, which is drawn above the page.

interface Tip {
  text: string;
  kbd: string[];
  rect: DOMRect;
  side: Side;
}

const SHOW_DELAY = 420;
const WARM_WINDOW = 500;

function tipTarget(node: EventTarget | null): HTMLElement | null {
  if (!(node instanceof Element)) return null;
  const element = node.closest<HTMLElement>("[data-tip]");
  if (!element || !element.dataset.tip?.trim()) return null;
  return element;
}

function describe(element: HTMLElement): Tip {
  const kbd = (element.dataset.tipKbd ?? "")
    .split(/\s*\+\s*/)
    .map((key) => key.trim())
    .filter(Boolean);
  const side = (element.dataset.tipSide as Side | undefined) ?? "bottom";
  return { text: element.dataset.tip ?? "", kbd, rect: element.getBoundingClientRect(), side };
}

export function TooltipLayer() {
  const [tip, setTip] = useState<Tip | null>(null);
  // A new tip renders off-screen first, so it is measured at its natural width.
  const [placed, setPlaced] = useState<{ tip: Tip; box: Box } | null>(null);
  const box = placed && placed.tip === tip ? placed.box : null;
  const dock = useDockArea();
  const ref = useRef<HTMLDivElement>(null);
  const timer = useRef(0);
  const lastHidden = useRef(0);
  const current = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const hide = () => {
      window.clearTimeout(timer.current);
      if (current.current) lastHidden.current = Date.now();
      current.current = null;
      setTip(null);
    };
    const show = (element: HTMLElement, immediate: boolean) => {
      window.clearTimeout(timer.current);
      current.current = element;
      const reveal = () => {
        if (current.current !== element || !element.isConnected) return;
        setTip(describe(element));
      };
      if (immediate) reveal();
      else timer.current = window.setTimeout(reveal, SHOW_DELAY);
    };
    const warm = () => Date.now() - lastHidden.current < WARM_WINDOW;

    const onOver = (event: PointerEvent) => {
      const element = tipTarget(event.target);
      if (element === current.current) return;
      if (!element) {
        hide();
        return;
      }
      show(element, warm());
    };
    const onFocus = (event: FocusEvent) => {
      const element = tipTarget(event.target);
      if (!element || !(event.target as Element).matches(":focus-visible")) return;
      show(element, true);
    };
    window.addEventListener("pointerover", onOver);
    window.addEventListener("pointerdown", hide, true);
    window.addEventListener("keydown", hide, true);
    window.addEventListener("scroll", hide, true);
    window.addEventListener("blur", hide);
    window.addEventListener("focusin", onFocus);
    window.addEventListener("focusout", hide);
    return () => {
      window.removeEventListener("pointerover", onOver);
      window.removeEventListener("pointerdown", hide, true);
      window.removeEventListener("keydown", hide, true);
      window.removeEventListener("scroll", hide, true);
      window.removeEventListener("blur", hide);
      window.removeEventListener("focusin", onFocus);
      window.removeEventListener("focusout", hide);
      window.clearTimeout(timer.current);
    };
  }, []);

  useLayoutEffect(() => {
    const node = ref.current;
    if (!tip || !node) return;
    const { width, height } = node.getBoundingClientRect();
    const spot = placeTip(tip.rect, { width, height }, tip.side, { width: window.innerWidth, height: window.innerHeight }, dock);
    setPlaced({ tip, box: { left: spot.left, top: spot.top, right: spot.left + width, bottom: spot.top + height } });
  }, [tip, dock]);

  // Placement keeps clear of the dock whenever there is room; when there isn't, the dock
  // sees this box land on it and steps aside.
  useLayer(box);

  if (!tip) return null;
  return createPortal(
    <div ref={ref} className="tooltip" role="tooltip" style={box ? { left: box.left, top: box.top } : { left: -9999, top: -9999 }}>
      <span>{tip.text}</span>
      {tip.kbd.length > 0 && (
        <span className="tooltip-keys">
          {tip.kbd.map((key) => (
            <kbd key={key}>{key}</kbd>
          ))}
        </span>
      )}
    </div>,
    document.body,
  );
}

/** Props that give any element the app's tooltip. */
export function tipProps(text: string | undefined, opts: { kbd?: string; side?: Side } = {}): Record<string, string | undefined> {
  if (!text) return {};
  return { "data-tip": text, "data-tip-kbd": opts.kbd, "data-tip-side": opts.side };
}
