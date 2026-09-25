import { AlertTriangle, CheckCircle2, Info, Loader2, X, XCircle, type LucideIcon } from "lucide-react";
import {
  forwardRef,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from "react";
import { createPortal } from "react-dom";
import type { RunStatus } from "../../shared/api.js";
import { initials, timeAgo } from "../../shared/text.js";
import { useNow } from "../api.js";
import { useConfirmState, useOverlay, useToast } from "../state.js";

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
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "default", size = "md", icon: Icon, busy, pressed, className, children, disabled, ...rest },
  ref,
) {
  const iconOnly = !children;
  const iconSize = size === "sm" ? 13 : 15;
  return (
    <button
      ref={ref}
      type="button"
      className={cx("btn", variant !== "default" && variant, size !== "md" && size, iconOnly && "icon", className)}
      disabled={disabled || busy}
      aria-pressed={pressed}
      {...rest}
    >
      {busy ? <Loader2 size={iconSize} className="spin" /> : Icon ? <Icon size={iconSize} strokeWidth={2} /> : null}
      {children}
    </button>
  );
});

// ------------------------------------------------------------------ form controls

export function Field({
  label,
  hint,
  error,
  children,
  className,
}: {
  label?: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cx("field", className)}>
      {label && <span className="field-label">{label}</span>}
      {children}
      {error ? <span className="error">{error}</span> : hint ? <span className="hint">{hint}</span> : null}
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
}: {
  value: T;
  options: Array<{ value: T; label: ReactNode; icon?: LucideIcon }>;
  onChange: (value: T) => void;
}) {
  return (
    <div className="segmented" role="group">
      {options.map((option) => (
        <button key={option.value} type="button" aria-pressed={value === option.value} onClick={() => onChange(option.value)}>
          {option.icon && <option.icon size={13} />}
          {option.label}
        </button>
      ))}
    </div>
  );
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
    <div className="tabs" role="tablist">
      {tabs.map((tab) => (
        <button key={tab.value} type="button" role="tab" className="tab" aria-selected={value === tab.value} onClick={() => onChange(tab.value)}>
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
    <span className={cx("chip", tone)} title={title}>
      {Icon && <Icon size={11} strokeWidth={2.4} />}
      {children}
    </span>
  );
}

export function StatusDot({ status, title }: { status: RunStatus | "idle" | null | undefined; title?: string }) {
  return <span className={cx("dot", status ?? "idle")} title={title ?? status ?? undefined} />;
}

export const STATUS_TEXT: Record<RunStatus, string> = {
  running: "Running",
  exited: "Finished",
  stopped: "Stopped",
  failed: "Failed",
};

export function StatusChip({ status, exitCode }: { status: RunStatus; exitCode?: number | null }) {
  if (status === "running") return <Chip tone="accent">Running</Chip>;
  if (status === "failed") return <Chip tone="bad">Failed</Chip>;
  if (status === "stopped") return <Chip tone="warn">Stopped</Chip>;
  if (exitCode && exitCode !== 0) return <Chip tone="bad">Exit {exitCode}</Chip>;
  return <Chip tone="ok">Finished</Chip>;
}

export function Kbd({ children }: { children: ReactNode }) {
  return <span className="kbd">{children}</span>;
}

export function Spinner() {
  return <span className="spinner" />;
}

export function Avatar({ name, size }: { name: string; size?: "lg" }) {
  return <span className={cx("avatar", size)}>{initials(name)}</span>;
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
  const now = useNow(20_000);
  if (!iso) return null;
  return (
    <span title={new Date(iso).toLocaleString()}>
      {prefix}
      {timeAgo(iso, now)}
    </span>
  );
}

export function SecretNote() {
  return (
    <Notice tone="warn" icon={AlertTriangle}>
      Don't put passwords, keys or tokens here. This text is handed to the CLI as plain text.
    </Notice>
  );
}

export function Logo({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" aria-hidden>
      <defs>
        <linearGradient id="vf-logo" x1="4" y1="28" x2="28" y2="4" gradientUnits="userSpaceOnUse">
          <stop stopColor="var(--accent)" />
          <stop offset="1" stopColor="var(--accent-2)" />
        </linearGradient>
      </defs>
      <path d="M5 7.5 L13.2 26 a3 3 0 0 0 5.6 0 L27 7.5" stroke="url(#vf-logo)" strokeWidth="3.4" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M16 5.5 l1.3 3.2 3.2 1.3 -3.2 1.3 -1.3 3.2 -1.3 -3.2 -3.2 -1.3 3.2 -1.3 z" fill="url(#vf-logo)" />
    </svg>
  );
}

// ------------------------------------------------------------------ overlays

function useEscape(onClose: () => void, enabled = true): void {
  useEffect(() => {
    if (!enabled) return;
    const handler = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [onClose, enabled]);
}

export function Modal({
  title,
  icon: Icon,
  onClose,
  children,
  footer,
  wide,
}: {
  title: ReactNode;
  icon?: LucideIcon;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}) {
  useOverlay(true);
  useEscape(onClose);
  return createPortal(
    <div className="scrim" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className={cx("modal", wide && "wide")} role="dialog" aria-modal>
        <div className="modal-head">
          {Icon && <Icon size={18} className="accent-text" />}
          <h2 className="grow">{title}</h2>
          <Button variant="ghost" size="sm" icon={X} onClick={onClose} title="Close (Esc)" />
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

export function Sheet({ onClose, children, width }: { onClose: () => void; children: ReactNode; width?: number }) {
  useOverlay(true);
  useEscape(onClose);
  return createPortal(
    <>
      <div className="sheet-scrim" onMouseDown={onClose} />
      <div className="sheet" role="dialog" aria-modal style={width ? { width: `min(${width}px, calc(100vw - 120px))` } : undefined}>
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
  disabled?: boolean;
}

/** A small floating menu anchored to an element. */
export function Popover({ anchor, onClose, children, align = "start" }: { anchor: HTMLElement; onClose: () => void; children: ReactNode; align?: "start" | "end" }) {
  useOverlay(true);
  useEscape(onClose);
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  useLayoutEffect(() => {
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
    setPos({ top, left });
  }, [anchor, align]);
  useEffect(() => {
    const handler = (event: MouseEvent) => {
      if (ref.current?.contains(event.target as Node) || anchor.contains(event.target as Node)) return;
      onClose();
    };
    window.addEventListener("mousedown", handler);
    return () => window.removeEventListener("mousedown", handler);
  }, [anchor, onClose]);
  return createPortal(
    <div ref={ref} className="popover" style={pos ? { top: pos.top, left: pos.left } : { visibility: "hidden", top: 0, left: 0 }}>
      {children}
    </div>,
    document.body,
  );
}

export function Menu({ items, onClose }: { items: Array<MenuItem | "sep">; onClose: () => void }) {
  return (
    <div role="menu">
      {items.map((item, index) =>
        item === "sep" ? (
          <div key={`sep-${index}`} className="menu-sep" />
        ) : (
          <button
            key={index}
            type="button"
            role="menuitem"
            className="menu-item"
            disabled={item.disabled}
            style={item.danger ? { color: "var(--red)" } : undefined}
            onClick={() => {
              onClose();
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

export function Toasts() {
  const { toasts, dismiss } = useToast();
  return createPortal(
    <div className="toasts" aria-live="polite">
      {toasts.map((toast) => {
        const Icon = toast.kind === "error" ? XCircle : toast.kind === "success" ? CheckCircle2 : Info;
        return (
          <div key={toast.id} className={cx("toast", toast.kind)} role={toast.kind === "error" ? "alert" : "status"}>
            <Icon size={16} className="toast-icon" />
            <div className="grow">
              <div className="toast-title">{toast.title}</div>
              {toast.body && <div className="toast-body selectable">{toast.body}</div>}
            </div>
            <Button variant="ghost" size="sm" icon={X} onClick={() => dismiss(toast.id)} title="Dismiss" />
          </div>
        );
      })}
    </div>,
    document.body,
  );
}

export function ConfirmDialog() {
  const { request, settle } = useConfirmState();
  const [typed, setTyped] = useState("");
  useEffect(() => setTyped(""), [request]);
  if (!request) return null;
  const blocked = Boolean(request.typeToConfirm) && typed.trim() !== request.typeToConfirm;
  return (
    <Modal
      title={request.title}
      icon={request.danger ? AlertTriangle : undefined}
      onClose={() => settle(false)}
      footer={
        <>
          <Button variant="ghost" onClick={() => settle(false)}>
            Cancel
          </Button>
          <Button variant={request.danger ? "danger" : "primary"} disabled={blocked} onClick={() => settle(true)} autoFocus={!request.typeToConfirm}>
            {request.confirm ?? "Continue"}
          </Button>
        </>
      }
    >
      {request.body && <div className="muted" style={{ lineHeight: 1.55 }}>{request.body}</div>}
      {request.typeToConfirm && (
        <Field label={<>Type <strong className="accent-text">{request.typeToConfirm}</strong> to confirm</>}>
          <Input
            autoFocus
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !blocked) settle(true);
            }}
          />
        </Field>
      )}
    </Modal>
  );
}
