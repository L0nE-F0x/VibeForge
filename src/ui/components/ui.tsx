import { AlertTriangle, CheckCircle2, Info, KeyRound, Loader2, X, XCircle, type LucideIcon } from "lucide-react";
import {
  forwardRef,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefObject,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from "react";
import { createPortal } from "react-dom";
import type { RunStatus } from "../../shared/api.js";
import { identicon, mark, shade } from "../../shared/pixel.js";
import { initials, shortAgo, timeAgo } from "../../shared/text.js";
import { useNow } from "../api.js";
import { sameBox, toastRight, type Box } from "../floating.js";
import { useT, type Key } from "../i18n/index.js";
import { pushOverlay, returnFocus } from "../overlays.js";
import { useConfirmState, useDockArea, useLayer, useOverlay, useToast, useToastList } from "../state.js";
import { shortcutKeys } from "../shortcuts.js";
import { tipProps } from "./Tooltip.js";

function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

export { cx };

// ------------------------------------------------------------------ buttons

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "default" | "primary" | "ghost" | "danger";
  size?: "sm" | "md" | "lg";
  icon?: LucideIcon;
  busy?: boolean;
  pressed?: boolean;
  /** Tooltip text; `title` is treated the same way so every button gets the app's tooltip. */
  tip?: string;
  /** Keyboard shortcut shown in the tooltip, e.g. "Ctrl+B". */
  kbd?: string;
  tipSide?: "top" | "bottom" | "left" | "right";
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "default", size = "md", icon: Icon, busy, pressed, className, children, disabled, tip, kbd, tipSide, title, ...rest },
  ref,
) {
  const iconOnly = !children;
  const iconSize = size === "sm" ? 13 : 15;
  const label = tip ?? title;
  return (
    <button
      ref={ref}
      type="button"
      className={cx("btn", variant !== "default" && variant, size !== "md" && size, iconOnly && "icon", className)}
      disabled={disabled || busy}
      aria-pressed={pressed}
      aria-label={iconOnly ? label : undefined}
      {...tipProps(label, { kbd, side: tipSide })}
      {...rest}
    >
      {busy ? <Loader2 size={iconSize} className="spin" /> : Icon ? <Icon size={iconSize} strokeWidth={2} /> : null}
      {children}
    </button>
  );
});

// ------------------------------------------------------------------ form controls

/**
 * A long hint keeps its first sentence on the form and the rest behind a small mark, so a form
 * reads as a form and not a manual. `more` puts its own text behind the mark.
 */
export function splitHint(text: string, longer = 110): { first: string; rest: string } | null {
  if (text.length <= longer) return null;
  for (let index = 0; index < text.length - 1; index += 1) {
    const char = text[index];
    const western = ".!?".includes(char) && text[index + 1] === " ";
    const cjk = "。！？".includes(char);
    if (!western && !cjk) continue;
    const first = text.slice(0, index + 1);
    const rest = text.slice(index + 1).trim();
    return first.length >= 24 && rest ? { first, rest } : null;
  }
  return null;
}

export function HintMore({ text }: { text: string }) {
  return (
    <span className="hint-more" tabIndex={0} aria-label={text} {...tipProps(text)}>
      <Info size={11} />
    </span>
  );
}

export function Field({
  label,
  hint,
  error,
  more,
  children,
  className,
}: {
  label?: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  /** More about the field, behind a small mark after the hint. */
  more?: string;
  children: ReactNode;
  className?: string;
}) {
  const split = typeof hint === "string" && !more ? splitHint(hint) : null;
  const shown = split ? split.first : hint;
  const extra = more ?? split?.rest;
  return (
    <div className={cx("field", className)}>
      {label && <span className="field-label">{label}</span>}
      {children}
      {error ? (
        <span className="error">{error}</span>
      ) : shown || extra ? (
        <span className="hint">
          {shown}
          {extra && <HintMore text={extra} />}
        </span>
      ) : null}
    </div>
  );
}

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean }>(function Input(
  { className, invalid, ...rest },
  ref,
) {
  return <input ref={ref} className={cx("input", invalid && "invalid", className)} spellCheck={false} {...rest} />;
});

export const TextArea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement> & { code?: boolean; invalid?: boolean }>(
  function TextArea({ className, code, invalid, ...rest }, ref) {
    return <textarea ref={ref} className={cx("textarea", code && "code", invalid && "invalid", className)} spellCheck={!code} {...rest} />;
  },
);

export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select className={cx("select", className)} {...rest}>
      {children}
    </select>
  );
}

export function Toggle({ checked, onChange, label, disabled }: { checked: boolean; onChange: (value: boolean) => void; label?: ReactNode; disabled?: boolean }) {
  return (
    <label className="toggle" style={disabled ? { opacity: 0.5, cursor: "default" } : undefined}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)} />
      <span className="track" />
      {label && <span>{label}</span>}
    </label>
  );
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  disabled,
}: {
  value: T;
  options: Array<{ value: T; label: ReactNode; icon?: LucideIcon }>;
  onChange: (value: T) => void;
  disabled?: boolean;
}) {
  return (
    <div className="segmented" role="group" onKeyDown={(event) => moveChoice(event, options, value, onChange)}>
      {options.map((option, index) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={value === option.value}
          disabled={disabled}
          tabIndex={value === option.value || (index === 0 && !options.some((item) => item.value === value)) ? 0 : -1}
          onClick={() => onChange(option.value)}
        >
          {option.icon && <option.icon size={13} />}
          {option.label}
        </button>
      ))}
    </div>
  );
}

/** ←/→ (and Home/End) move a tab row or a segmented choice, as the keyboard expects of both. */
function moveChoice<T>(event: React.KeyboardEvent<HTMLElement>, options: Array<{ value: T }>, value: T, onChange: (value: T) => void): void {
  if (event.altKey || event.ctrlKey || event.metaKey) return;
  const at = options.findIndex((option) => option.value === value);
  const to =
    event.key === "ArrowRight" ? Math.min(options.length - 1, at + 1) : event.key === "ArrowLeft" ? Math.max(0, at - 1) : event.key === "Home" ? 0 : event.key === "End" ? options.length - 1 : -1;
  if (to < 0) return;
  event.preventDefault();
  if (to === at) return;
  onChange(options[to].value);
  const buttons = event.currentTarget.querySelectorAll<HTMLElement>(":scope > button");
  buttons[to]?.focus();
  buttons[to]?.scrollIntoView({ block: "nearest", inline: "nearest" });
}

export function Tabs<T extends string>({
  value,
  tabs,
  onChange,
}: {
  value: T;
  tabs: Array<{ value: T; label: ReactNode; icon?: LucideIcon; badge?: ReactNode }>;
  onChange: (value: T) => void;
}) {
  return (
    <div className="tabs" role="tablist" onKeyDown={(event) => moveChoice(event, tabs, value, onChange)}>
      {tabs.map((tab) => (
        <button key={tab.value} type="button" role="tab" className="tab" aria-selected={value === tab.value} tabIndex={value === tab.value ? 0 : -1} onClick={() => onChange(tab.value)}>
          {tab.icon && <tab.icon size={14} />}
          {tab.label}
          {tab.badge}
        </button>
      ))}
    </div>
  );
}

// ------------------------------------------------------------------ small display pieces

export function Chip({ tone, children, title, icon: Icon }: { tone?: "accent" | "ok" | "warn" | "bad" | "info"; children: ReactNode; title?: string; icon?: LucideIcon }) {
  return (
    <span className={cx("chip", tone)} {...tipProps(title)}>
      {Icon && <Icon size={11} strokeWidth={2.4} />}
      {children}
    </span>
  );
}

export function StatusDot({ status, title }: { status: RunStatus | "idle" | null | undefined; title?: string }) {
  const t = useT();
  const label = title ?? (status && status !== "idle" ? t(STATUS_KEY[status]) : undefined);
  // A screen reader hears what the colour says; a dot that says nothing is left out.
  return <span className={cx("dot", status ?? "idle")} role={label ? "img" : undefined} aria-label={label} aria-hidden={label ? undefined : true} {...tipProps(label)} />;
}

export const STATUS_KEY: Record<RunStatus, Key> = {
  running: "status.running",
  exited: "status.exited",
  stopped: "status.stopped",
  failed: "status.failed",
};

export function StatusChip({ status, exitCode }: { status: RunStatus; exitCode?: number | null }) {
  const t = useT();
  if (status === "running") return <Chip tone="accent">{t("status.running")}</Chip>;
  if (status === "failed") return <Chip tone="bad">{t("status.failed")}</Chip>;
  if (status === "stopped") return <Chip tone="warn">{t("status.stopped")}</Chip>;
  if (exitCode && exitCode !== 0) return <Chip tone="bad">{t("status.exit", { code: exitCode })}</Chip>;
  return <Chip tone="ok">{t("status.exited")}</Chip>;
}

export function Kbd({ children }: { children: ReactNode }) {
  return <span className="kbd">{children}</span>;
}

export function Spinner() {
  return <span className="spinner" />;
}

const SKELETON_WIDTHS = [[72, 46], [58, 38], [80, 52], [64, 30], [50, 42]];

/**
 * Stand-in rows while a list or page loads, shaped like what is coming so nothing jumps when it
 * lands. They stay invisible for the first moment, so a quick local read never flickers.
 */
export function Skeleton({ rows = 4, page }: { rows?: number; page?: boolean }) {
  return (
    <div className={cx("skeleton", page && "is-page")} aria-hidden>
      {page && <span className="skeleton-head" />}
      {Array.from({ length: rows }, (_, index) => {
        const [first, second] = SKELETON_WIDTHS[index % SKELETON_WIDTHS.length];
        return (
          <div key={index} className="skeleton-row">
            <span className="skeleton-pixel" />
            <span className="skeleton-lines">
              <span style={{ width: `${first}%` }} />
              <span style={{ width: `${second}%` }} />
            </span>
          </div>
        );
      })}
    </div>
  );
}

/** A teammate's pixel face (shared/pixel.ts identicon), shaded in the theme's accents like the logo. */
export function Avatar({ name, size }: { name: string; size?: "lg" }) {
  const art = useMemo(() => identicon(name), [name]);
  return (
    <span className={cx("avatar", size)} role="img" aria-label={initials(name)}>
      <svg viewBox="0 0 5 5" shapeRendering="crispEdges" aria-hidden>
        {art.cells.map((cell) => (
          <rect key={`${cell.x}.${cell.y}`} x={cell.x} y={cell.y} width={1} height={1} className={`px-s${shade(cell.y, art.height)}`} />
        ))}
      </svg>
    </span>
  );
}

export function Empty({ icon: Icon, title, children, actions }: { icon: LucideIcon; title: ReactNode; children?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="empty">
      <div className="empty-icon">
        <Icon size={24} strokeWidth={1.8} />
      </div>
      <h2>{title}</h2>
      {children && <p>{children}</p>}
      {actions && <div className="actions">{actions}</div>}
    </div>
  );
}

export function Notice({ tone, icon: Icon = Info, children }: { tone?: "warn" | "bad" | "accent"; icon?: LucideIcon; children: ReactNode }) {
  return (
    <div className={cx("notice", tone)}>
      <Icon size={14} />
      <div>{children}</div>
    </div>
  );
}

export function TimeAgo({ iso, prefix }: { iso: string | null | undefined; prefix?: string }) {
  const t = useT();
  const now = useNow(20_000);
  if (!iso) return null;
  return (
    <span {...tipProps(new Date(iso).toLocaleString(t.language))}>
      {prefix}
      {timeAgo(iso, now, t.language)}
    </span>
  );
}

/** How long ago, as short as the language writes it ("16m"), for a narrow list. */
export function ShortAgo({ iso }: { iso: string | null | undefined }) {
  const t = useT();
  const now = useNow(20_000);
  if (!iso) return null;
  return <span {...tipProps(new Date(iso).toLocaleString(t.language))}>{shortAgo(iso, now, t.language)}</span>;
}

/** A page's subtitle: its first sentence, and the rest behind a mark when it runs long. */
export function PageSub({ text }: { text: string }) {
  const split = splitHint(text, 90);
  return (
    <span className="sub truncate">
      {split ? split.first : text}
      {split && <HintMore text={split.rest} />}
    </span>
  );
}

/** Said once per form, quietly: what goes in the box is handed to a CLI as plain text. */
export function SecretNote() {
  const t = useT();
  return (
    <span className="secret-note">
      <KeyRound size={12} />
      {t("common.secretNote")}
    </span>
  );
}

/** The VibeForge mark: the pixel V and spark (shared/pixel.ts), shaded in the theme's accents. */
export function Logo({ size = 22 }: { size?: number }) {
  const art = mark();
  return (
    <svg width={size} height={size} viewBox={`0 0 ${art.width} ${art.height}`} shapeRendering="crispEdges" aria-hidden>
      {art.cells.map((cell) => (
        <rect key={`${cell.x}.${cell.y}`} x={cell.x} y={cell.y} width={1} height={1} className={`px-s${shade(cell.y, art.height)}`} />
      ))}
    </svg>
  );
}

// ------------------------------------------------------------------ overlays

/**
 * An overlay on the app's one stack (overlays.ts): Escape closes it only while it is on top, and
 * when it closes, focus goes back to what had it (the button that opened it, the terminal). A
 * dialog (`trap`) also takes focus when it opens and keeps Tab inside; a menu leaves focus be.
 */
export function useOverlayStack(ref: RefObject<HTMLElement | null>, onClose: () => void, { trap = true }: { trap?: boolean } = {}): void {
  const close = useRef(onClose);
  close.current = onClose;
  // Read while rendering, before a field inside marked autoFocus takes focus.
  const [opener] = useState(() => (document.activeElement instanceof HTMLElement ? document.activeElement : null));
  // That field, so a second mount (React's dev check) hands focus back to it.
  const autoFocused = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const node = ref.current;
    const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const outside = (element: HTMLElement | null) => (element && element !== document.body && !node?.contains(element) ? element : null);
    // A menu item that opened this has gone with its menu; the menu put focus back on its button.
    const before = (opener?.isConnected ? outside(opener) : null) ?? outside(active);
    const pop = pushOverlay({ close: () => close.current(), node: () => ref.current, trap });
    if (trap && node) {
      if (active && node.contains(active)) autoFocused.current = active;
      else if (autoFocused.current?.isConnected && node.contains(autoFocused.current)) autoFocused.current.focus({ preventScroll: true });
      else node.focus({ preventScroll: true });
    }
    return () => {
      pop();
      returnFocus(before, node);
    };
  }, [ref, trap, opener]);
}

export function Modal({
  title,
  icon: Icon,
  onClose,
  children,
  footer,
  wide,
  terminal,
}: {
  title: ReactNode;
  icon?: LucideIcon;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
  /** It holds a terminal, where Escape is the program's and Shift+Esc closes the dialog. */
  terminal?: boolean;
}) {
  const t = useT();
  const titleId = useId();
  const ref = useRef<HTMLDivElement>(null);
  useOverlay(true);
  useOverlayStack(ref, onClose);
  return createPortal(
    <div className="scrim" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div ref={ref} className={cx("modal", wide && "wide")} role="dialog" aria-modal aria-labelledby={titleId} tabIndex={-1}>
        <div className="modal-head">
          {Icon && <Icon size={18} className="accent-text" />}
          <h2 className="grow" id={titleId}>
            {title}
          </h2>
          <Button variant="ghost" size="sm" icon={X} onClick={onClose} title={t(terminal ? "common.closeEscTerminal" : "common.closeEsc")} />
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

export function Sheet({ onClose, children, width, label }: { onClose: () => void; children: ReactNode; width?: number; label?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useOverlay(true);
  useOverlayStack(ref, onClose);
  return createPortal(
    <>
      <div className="sheet-scrim" onMouseDown={onClose} />
      <div
        ref={ref}
        className="sheet"
        role="dialog"
        aria-modal
        aria-label={label}
        tabIndex={-1}
        style={width ? { width: `min(${width}px, calc(100vw - 120px))` } : undefined}
      >
        {children}
      </div>
    </>,
    document.body,
  );
}

export interface MenuItem {
  label: ReactNode;
  icon?: LucideIcon;
  hint?: ReactNode;
  onSelect: () => void;
  danger?: boolean;
  /** Stands out in the accent colour, for the one thing worth noticing (an available update). */
  accent?: boolean;
  disabled?: boolean;
  /** A step inside the menu (picking where to go next), so choosing it doesn't close the menu. */
  keepOpen?: boolean;
}

const POPOVER_FOCUSABLE = 'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';

/**
 * A small floating menu anchored to an element. It moves to stay inside the window when its
 * content grows or shrinks. `tall` lets it use the window's height instead of 60% of it.
 */
export function Popover({
  anchor,
  onClose,
  children,
  align = "start",
  tall = false,
}: {
  anchor: HTMLElement;
  onClose: () => void;
  children: ReactNode;
  align?: "start" | "end";
  tall?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useOverlayStack(ref, onClose, { trap: false });
  const [pos, setPos] = useState<Box | null>(null);
  useLayer(pos);
  const place = useCallback(() => {
    const rect = anchor.getBoundingClientRect();
    const node = ref.current;
    const width = node?.offsetWidth ?? 260;
    const height = node?.offsetHeight ?? 200;
    let left = align === "end" ? rect.right - width : rect.left;
    let top = rect.bottom + 6;
    if (top + height > window.innerHeight - 8) top = Math.max(8, rect.top - height - 6);
    if (left + width > window.innerWidth - 8) left = window.innerWidth - width - 8;
    if (left < 8) left = 8;
    if (rect.left < 80 && align === "start" && rect.right < 80) {
      left = rect.right + 8;
      top = Math.min(rect.top, window.innerHeight - height - 8);
    }
    setPos((was) => (was && was.left === left && was.top === top && was.right === left + width && was.bottom === top + height ? was : { left, top, right: left + width, bottom: top + height }));
  }, [anchor, align]);
  useLayoutEffect(place, [place]);
  useEffect(() => {
    const node = ref.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => place());
    observer.observe(node);
    return () => observer.disconnect();
  }, [place]);
  // Opened from the keyboard (or a click, which focuses its button), focus moves into it: the first
  // menu item, else the first control. Portaled to the end of the page, it would otherwise be
  // reached only after Tab had walked the whole page. Once it is placed, since a hidden element
  // can't take focus.
  const entered = useRef(false);
  const placed = pos !== null;
  useEffect(() => {
    const node = ref.current;
    if (!placed || entered.current || !node) return;
    entered.current = true;
    const active = document.activeElement;
    if (!active || !(active === anchor || anchor.contains(active))) return;
    const first = node.querySelector<HTMLElement>('[role="menuitem"]:not(:disabled)') ?? node.querySelector<HTMLElement>(POPOVER_FOCUSABLE);
    first?.focus({ preventScroll: true });
  }, [placed, anchor]);
  // Tab past its last control (or Shift+Tab past its first) closes it, and focus goes back to its button.
  const onKeyDown = (event: ReactKeyboardEvent) => {
    if (event.key !== "Tab" || event.defaultPrevented || event.ctrlKey || event.altKey || event.metaKey) return;
    const node = ref.current;
    if (!node) return;
    const items = [...node.querySelectorAll<HTMLElement>(POPOVER_FOCUSABLE)].filter((item) => item.getClientRects().length > 0);
    const at = items.indexOf(document.activeElement as HTMLElement);
    if (at < 0 || (event.shiftKey ? at === 0 : at === items.length - 1)) {
      event.preventDefault();
      onClose();
    }
  };
  useEffect(() => {
    const handler = (event: MouseEvent) => {
      if (ref.current?.contains(event.target as Node) || anchor.contains(event.target as Node)) return;
      onClose();
    };
    window.addEventListener("mousedown", handler);
    // A click in the browser dock or in another window never reaches this page; it blurs it.
    window.addEventListener("blur", onClose);
    return () => {
      window.removeEventListener("mousedown", handler);
      window.removeEventListener("blur", onClose);
    };
  }, [anchor, onClose]);
  return createPortal(
    <div ref={ref} className={tall ? "popover tall" : "popover"} style={pos ? { top: pos.top, left: pos.left } : { visibility: "hidden", top: 0, left: 0 }} onKeyDown={onKeyDown}>
      {children}
    </div>,
    document.body,
  );
}

export function Menu({ items, onClose }: { items: Array<MenuItem | "sep">; onClose: () => void }) {
  // ↑/↓ move between its items (round the ends), Home/End go to the first and last; the Popover
  // puts focus on the first as it opens.
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const step = event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0;
    if (!step && event.key !== "Home" && event.key !== "End") return;
    const entries = [...event.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)')];
    if (!entries.length) return;
    event.preventDefault();
    const at = entries.indexOf(document.activeElement as HTMLElement);
    const next = event.key === "Home" ? 0 : event.key === "End" ? entries.length - 1 : at < 0 ? (step > 0 ? 0 : entries.length - 1) : (at + step + entries.length) % entries.length;
    entries[next].focus();
  };
  return (
    <div role="menu" onKeyDown={onKeyDown}>
      {items.map((item, index) =>
        item === "sep" ? (
          <div key={`sep-${index}`} className="menu-sep" />
        ) : (
          <button
            key={index}
            type="button"
            role="menuitem"
            className={cx("menu-item", item.accent && "accent")}
            disabled={item.disabled}
            style={item.danger ? { color: "var(--red)" } : undefined}
            onClick={() => {
              if (!item.keepOpen) onClose();
              item.onSelect();
            }}
          >
            {item.icon && <item.icon size={14} />}
            <span className="grow truncate">{item.label}</span>
            {item.hint && <span className="faint" style={{ fontSize: "var(--fs-xs)" }}>{item.hint}</span>}
          </button>
        ),
      )}
    </div>
  );
}

/** A button that opens a menu. */
export function MenuButton({ items, children, ...button }: Omit<ButtonProps, "onClick"> & { items: Array<MenuItem | "sep"> }) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  return (
    <>
      <Button {...button} pressed={anchor ? true : undefined} onClick={(event) => setAnchor(anchor ? null : event.currentTarget)}>
        {children}
      </Button>
      {anchor && (
        <Popover anchor={anchor} onClose={() => setAnchor(null)}>
          <Menu items={items} onClose={() => setAnchor(null)} />
        </Popover>
      )}
    </>
  );
}

const TOAST_EDGE = 16;

export function Toasts() {
  const t = useT();
  const toasts = useToastList();
  const { dismiss } = useToast();
  const dock = useDockArea();
  const ref = useRef<HTMLDivElement>(null);
  // The stack sits bottom right, or just left of the browser dock when it would land on it.
  const [place, setPlace] = useState<{ right: number; box: Box | null }>({ right: TOAST_EDGE, box: null });
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node || toasts.length === 0) {
      setPlace((prev) => (prev.box ? { right: TOAST_EDGE, box: null } : prev));
      return;
    }
    const view = { width: window.innerWidth, height: window.innerHeight };
    const stack = { width: node.offsetWidth, height: node.offsetHeight };
    const right = toastRight(stack, view, dock, TOAST_EDGE);
    const box = { left: view.width - right - stack.width, top: view.height - TOAST_EDGE - stack.height, right: view.width - right, bottom: view.height - TOAST_EDGE };
    setPlace((prev) => (prev.right === right && sameBox(prev.box, box) ? prev : { right, box }));
  }, [toasts, dock]);
  // With no room beside the dock, the stack lands on it and the dock steps aside.
  useLayer(place.box);
  return createPortal(
    <div ref={ref} className="toasts" aria-live="polite" style={place.right !== TOAST_EDGE ? { right: place.right } : undefined}>
      {toasts.map((toast) => {
        const Icon = toast.kind === "error" ? XCircle : toast.kind === "success" ? CheckCircle2 : Info;
        return (
          <div key={toast.id} className={cx("toast", toast.kind)} role={toast.kind === "error" ? "alert" : "status"}>
            <Icon size={16} className="toast-icon" />
            <div className="grow">
              <div className="toast-title">{toast.title}</div>
              {toast.body && <div className="toast-body selectable">{toast.body}</div>}
            </div>
            {toast.action && (
              <Button
                size="sm"
                className="toast-action"
                onClick={() => {
                  dismiss(toast.id);
                  toast.action?.run();
                }}
                tip={toast.action.label}
                kbd={shortcutKeys("toast.undo")}
              >
                {toast.action.label}
              </Button>
            )}
            <Button variant="ghost" size="sm" icon={X} onClick={() => dismiss(toast.id)} title={t("common.dismiss")} />
          </div>
        );
      })}
    </div>,
    document.body,
  );
}

export function ConfirmDialog() {
  const t = useT();
  const { request, settle } = useConfirmState();
  if (!request) return null;
  return (
    <Modal
      title={request.title}
      icon={request.danger ? AlertTriangle : undefined}
      onClose={() => settle(false)}
      footer={
        <>
          <Button variant="ghost" onClick={() => settle(false)}>
            {t("common.cancel")}
          </Button>
          <Button variant={request.danger ? "danger" : "primary"} onClick={() => settle(true)} autoFocus>
            {request.confirm ?? t("common.continue")}
          </Button>
        </>
      }
    >
      {request.body && <div className="muted" style={{ lineHeight: 1.55 }}>{request.body}</div>}
    </Modal>
  );
}
