import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

// One tooltip for the whole app. Any element with `data-tip` gets it; `data-tip-kbd` adds
// keycaps ("Ctrl+1") and `data-tip-side` picks a side (top, bottom, left, right).

type Side = "top" | "bottom" | "left" | "right";

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
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
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
    if (!tip || !node) {
      setPos(null);
      return;
    }
    const gap = 8;
    const { width, height } = node.getBoundingClientRect();
    const { rect } = tip;
    const place = (side: Side) => {
      if (side === "right") return { left: rect.right + gap, top: rect.top + rect.height / 2 - height / 2 };
      if (side === "left") return { left: rect.left - gap - width, top: rect.top + rect.height / 2 - height / 2 };
      if (side === "top") return { left: rect.left + rect.width / 2 - width / 2, top: rect.top - gap - height };
      return { left: rect.left + rect.width / 2 - width / 2, top: rect.bottom + gap };
    };
    const fits = (spot: { left: number; top: number }) =>
      spot.left >= 4 && spot.top >= 4 && spot.left + width <= window.innerWidth - 4 && spot.top + height <= window.innerHeight - 4;
    const opposite: Record<Side, Side> = { top: "bottom", bottom: "top", left: "right", right: "left" };
    let spot = place(tip.side);
    if (!fits(spot)) {
      const flipped = place(opposite[tip.side]);
      if (fits(flipped)) spot = flipped;
    }
    spot.left = Math.min(Math.max(4, spot.left), window.innerWidth - width - 4);
    spot.top = Math.min(Math.max(4, spot.top), window.innerHeight - height - 4);
    setPos(spot);
  }, [tip]);

  if (!tip) return null;
  return createPortal(
    <div ref={ref} className="tooltip" role="tooltip" style={pos ? { left: pos.left, top: pos.top } : { left: -9999, top: -9999 }}>
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
