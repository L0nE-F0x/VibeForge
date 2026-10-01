import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import type { Deleted, RunView } from "../shared/api.js";
import { call, errorText } from "./api.js";
import { t as translate, useT } from "./i18n/index.js";
import { covers, sameBox, type Box, type Layer } from "./floating.js";

// ------------------------------------------------------------------ routes

export type AgentTab = "chats" | "brief" | "memory" | "skills" | "folders" | "runs" | "settings";

export type Route =
  | { view: "home" }
  | { view: "agents"; agentId?: string; tab?: AgentTab; chatId?: string }
  | { view: "code"; workspaceId?: string; ptyId?: string }
  | { view: "chat"; chatId?: string }
  | { view: "tasks"; taskId?: string }
  | { view: "routines"; routineId?: string }
  | { view: "skills"; skillId?: string }
  | { view: "runs"; runId?: string; filter?: RunFilter }
  | { view: "settings" };

export type RunFilter = "review" | "all" | "live";

export type ViewName = Route["view"];

interface Nav {
  route: Route;
  go: (route: Route) => void;
  /** Switch to a view where you left it: the same agent, chat, task or run. */
  open: (view: ViewName) => void;
  /** Go somewhere without leaving the current place in the history. */
  replace: (route: Route) => void;
  back: () => void;
  forward: () => void;
}

const NavContext = createContext<Nav | null>(null);

function pushRoute(prev: Route[], route: Route): Route[] {
  if (JSON.stringify(prev[prev.length - 1]) === JSON.stringify(route)) return prev;
  return [...prev.slice(-30), route];
}

const VIEWS: ViewName[] = ["home", "agents", "code", "chat", "tasks", "routines", "skills", "runs", "settings"];
const NAV_KEY = "vf.nav";

function isRoute(value: unknown): value is Route {
  return Boolean(value) && typeof value === "object" && VIEWS.includes((value as Route).view);
}

/** Where the last session was: the open view and where each view was left. */
function loadNav(): { route: Route; left: Array<[ViewName, Route]> } {
  try {
    const saved = JSON.parse(localStorage.getItem(NAV_KEY) ?? "null") as { route?: unknown; left?: unknown } | null;
    const left = Array.isArray(saved?.left) ? saved.left.filter((entry): entry is [ViewName, Route] => Array.isArray(entry) && isRoute(entry[1]) && entry[1].view === entry[0]) : [];
    return { route: isRoute(saved?.route) ? saved.route : { view: "home" }, left };
  } catch {
    return { route: { view: "home" }, left: [] };
  }
}

export function NavProvider({ children }: { children: ReactNode }) {
  const saved = useRef<ReturnType<typeof loadNav> | null>(null);
  saved.current ??= loadNav();
  // Behind you, and ahead of you after going back. Going somewhere new drops what was ahead.
  const [history, setHistory] = useState<{ stack: Route[]; ahead: Route[] }>(() => ({ stack: [saved.current!.route], ahead: [] }));
  const route = history.stack[history.stack.length - 1];
  // Code stays mounted and keeps its own workspace, so it isn't remembered here.
  const left = useRef(new Map<ViewName, Route>(saved.current.left));
  useLayoutEffect(() => {
    if (route.view !== "code") left.current.set(route.view, route);
    try {
      localStorage.setItem(NAV_KEY, JSON.stringify({ route: route.view === "code" ? { view: "code" } : route, left: [...left.current] }));
    } catch {
      /* storage can be unavailable; the next launch opens Home */
    }
  }, [route]);
  const visit = useCallback((next: Route) => {
    setHistory((prev) => {
      const stack = pushRoute(prev.stack, next);
      return stack === prev.stack ? prev : { stack, ahead: [] };
    });
  }, []);
  const go = visit;
  const open = useCallback((view: ViewName) => visit(left.current.get(view) ?? ({ view } as Route)), [visit]);
  const replace = useCallback((next: Route) => setHistory((prev) => ({ ...prev, stack: [...prev.stack.slice(0, -1), next] })), []);
  const back = useCallback(
    () =>
      setHistory((prev) =>
        prev.stack.length > 1 ? { stack: prev.stack.slice(0, -1), ahead: [prev.stack[prev.stack.length - 1], ...prev.ahead].slice(0, 30) } : prev,
      ),
    [],
  );
  const forward = useCallback(
    () => setHistory((prev) => (prev.ahead.length ? { stack: [...prev.stack, prev.ahead[0]], ahead: prev.ahead.slice(1) } : prev)),
    [],
  );
  const value = useMemo(() => ({ route, go, open, replace, back, forward }), [route, go, open, replace, back, forward]);
  return <NavContext.Provider value={value}>{children}</NavContext.Provider>;
}

export function useNav(): Nav {
  const nav = useContext(NavContext);
  if (!nav) throw new Error("useNav outside NavProvider");
  return nav;
}

/**
 * A remembered place can point at something deleted since. Once the view's list has loaded, if
 * the route names something missing, open the view without it instead of an empty page.
 */
export function useDropMissing(loaded: boolean, missing: boolean, bare: Route): void {
  const { replace } = useNav();
  const checked = useRef(false);
  useEffect(() => {
    if (checked.current || !loaded) return;
    checked.current = true;
    if (missing) replace(bare);
  });
}

/** Where a run lives: its chat, its task, its pane, or the run page. */
export function routeForRun(run: Pick<RunView, "id" | "origin" | "agentId" | "chatId" | "taskId" | "workspaceId" | "live" | "ptyId">, preferReview = false): Route {
  if (preferReview) return { view: "runs", runId: run.id };
  if (run.origin === "agent-chat" && run.agentId && run.chatId) return { view: "agents", agentId: run.agentId, tab: "chats", chatId: run.chatId };
  if (run.origin === "chat" && run.chatId) return { view: "chat", chatId: run.chatId };
  if (run.origin === "task" && run.taskId) return { view: "tasks", taskId: run.taskId };
  if (run.origin === "code" && run.live && run.workspaceId) return { view: "code", workspaceId: run.workspaceId, ptyId: run.ptyId ?? undefined };
  return { view: "runs", runId: run.id };
}

// ------------------------------------------------------------------ floating layers
// The browser dock is a native view that Electron draws above the whole page. Tooltips and
// toasts keep clear of the area it publishes. Menus, dialogs and the tour register the space
// they take, and while one of them lands on the dock, the dock shows a still of its page instead.

let dockArea: Box | null = null;
const layers = new Map<symbol, Layer>();
const layerListeners = new Set<() => void>();

function layersChanged(): void {
  for (const listener of layerListeners) listener();
}

function subscribeLayers(listener: () => void): () => void {
  layerListeners.add(listener);
  return () => layerListeners.delete(listener);
}

/** The dock says where its live page is, or null while it has none on screen. */
export function setDockArea(area: Box | null): void {
  if (sameBox(dockArea, area)) return;
  dockArea = area;
  layersChanged();
}

/** Where the dock's page is, for floating things that keep clear of it. */
export function useDockArea(): Box | null {
  return useSyncExternalStore(subscribeLayers, () => dockArea);
}

/** Whether a registered layer lands on the dock right now. */
export function dockCovered(): boolean {
  return covers(layers.values(), dockArea);
}

/** True while a registered layer lands on the dock. */
export function useDockCovered(): boolean {
  return useSyncExternalStore(subscribeLayers, dockCovered);
}

/** Register the space a floating layer takes; null while it takes none. Pass a stable value. */
export function useLayer(layer: Layer | null): void {
  const id = useRef(Symbol("layer")).current;
  useLayoutEffect(() => {
    if (!layer) return;
    layers.set(id, layer);
    layersChanged();
    return () => {
      layers.delete(id);
      layersChanged();
    };
  }, [id, layer]);
}

/** A dialog, sheet or tour: its scrim covers the whole window while it is open. */
export function useOverlay(open: boolean): void {
  useLayer(open ? "window" : null);
}

// ------------------------------------------------------------------ toasts

export type ToastKind = "info" | "success" | "error";

/** A button on a toast, like Undo. */
export interface ToastAction {
  label: string;
  run: () => void;
}

export interface Toast {
  id: number;
  kind: ToastKind;
  title: string;
  body?: string;
  action?: ToastAction;
}

interface Toaster {
  toasts: Toast[];
  push: (kind: ToastKind, title: string, body?: string, action?: ToastAction) => void;
  dismiss: (id: number) => void;
  fail: (error: unknown, title?: string) => void;
}

const ToastContext = createContext<Toaster | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const seq = useRef(0);
  const dismiss = useCallback((id: number) => setToasts((prev) => prev.filter((toast) => toast.id !== id)), []);
  const push = useCallback(
    (kind: ToastKind, title: string, body?: string, action?: ToastAction) => {
      seq.current += 1;
      const id = seq.current;
      setToasts((prev) => [...prev.slice(-4), { id, kind, title, body, action }]);
      // A toast with a button stays long enough to reach it.
      setTimeout(() => dismiss(id), kind === "error" ? 9000 : action ? 9000 : 4500);
    },
    [dismiss],
  );
  // Ctrl+Z takes the newest toast's action (Undo) while it's up, unless you're typing somewhere.
  const latest = useRef<Toast | undefined>(undefined);
  latest.current = [...toasts].reverse().find((toast) => toast.action);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!event.ctrlKey || event.shiftKey || event.altKey || event.metaKey || event.key.toLowerCase() !== "z") return;
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, [contenteditable='true'], .xterm")) return;
      const toast = latest.current;
      if (!toast?.action) return;
      event.preventDefault();
      dismiss(toast.id);
      toast.action.run();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dismiss]);
  const fail = useCallback((error: unknown, title = translate("common.failed")) => push("error", title, errorText(error)), [push]);
  const value = useMemo(() => ({ toasts, push, dismiss, fail }), [toasts, push, dismiss, fail]);
  return <ToastContext.Provider value={value}>{children}</ToastContext.Provider>;
}

export function useToast(): Toaster {
  const toaster = useContext(ToastContext);
  if (!toaster) throw new Error("useToast outside ToastProvider");
  return toaster;
}

/**
 * After a delete: a toast saying what went, with Undo (and Ctrl+Z) to put it back. Deleting
 * this way needs no "are you sure?" first.
 */
export function useDeleted(): (title: string, deleted: Deleted) => void {
  const t = useT();
  const { push, fail } = useToast();
  return useCallback(
    (title: string, deleted: Deleted) =>
      push("info", title, deleted.copyLeft ? t("core.copyUntrusted") : undefined, {
        label: t("common.undo"),
        run: () => void call("undo.delete", deleted.undo).catch((error: unknown) => fail(error, t("common.undoFailed"))),
      }),
    [push, fail, t],
  );
}

/** Run an async action, report failure as a toast, and track whether it is running. */
export function useAction<A extends unknown[], R>(
  action: (...args: A) => Promise<R>,
  failTitle?: string,
): [(...args: A) => Promise<R | undefined>, boolean] {
  const { fail } = useToast();
  const [busy, setBusy] = useState(false);
  const ref = useRef(action);
  ref.current = action;
  const run = useCallback(
    async (...args: A) => {
      setBusy(true);
      try {
        return await ref.current(...args);
      } catch (error) {
        fail(error, failTitle);
        return undefined;
      } finally {
        setBusy(false);
      }
    },
    [fail, failTitle],
  );
  return [run, busy];
}

// ------------------------------------------------------------------ confirm

export interface ConfirmRequest {
  title: string;
  body?: ReactNode;
  confirm?: string;
  danger?: boolean;
  /** Ask the person to type this before confirming. */
  typeToConfirm?: string;
}

interface Confirmer {
  request: (ConfirmRequest & { resolve: (ok: boolean) => void }) | null;
  ask: (request: ConfirmRequest) => Promise<boolean>;
  settle: (ok: boolean) => void;
}

const ConfirmContext = createContext<Confirmer | null>(null);

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [request, setRequest] = useState<Confirmer["request"]>(null);
  const ask = useCallback(
    (next: ConfirmRequest) =>
      new Promise<boolean>((resolve) => {
        setRequest({ ...next, resolve });
      }),
    [],
  );
  const settle = useCallback(
    (ok: boolean) => {
      setRequest((current) => {
        current?.resolve(ok);
        return null;
      });
    },
    [],
  );
  const value = useMemo(() => ({ request, ask, settle }), [request, ask, settle]);
  return <ConfirmContext.Provider value={value}>{children}</ConfirmContext.Provider>;
}

export function useConfirm(): (request: ConfirmRequest) => Promise<boolean> {
  const confirmer = useContext(ConfirmContext);
  if (!confirmer) throw new Error("useConfirm outside ConfirmProvider");
  return confirmer.ask;
}

export function useConfirmState(): Confirmer {
  const confirmer = useContext(ConfirmContext);
  if (!confirmer) throw new Error("useConfirmState outside ConfirmProvider");
  return confirmer;
}
