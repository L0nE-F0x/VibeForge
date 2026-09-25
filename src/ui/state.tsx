import { createContext, useCallback, useContext, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import type { RunView } from "../shared/api.js";
import { errorText } from "./api.js";
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
  back: () => void;
}

const NavContext = createContext<Nav | null>(null);

export function NavProvider({ children }: { children: ReactNode }) {
  const [stack, setStack] = useState<Route[]>([{ view: "home" }]);
  const go = useCallback((route: Route) => {
    setStack((prev) => {
      const last = prev[prev.length - 1];
      if (JSON.stringify(last) === JSON.stringify(route)) return prev;
      return [...prev.slice(-30), route];
    });
  }, []);
  const back = useCallback(() => setStack((prev) => (prev.length > 1 ? prev.slice(0, -1) : prev)), []);
  const value = useMemo(() => ({ route: stack[stack.length - 1], go, back }), [stack, go, back]);
  return <NavContext.Provider value={value}>{children}</NavContext.Provider>;
}

export function useNav(): Nav {
  const nav = useContext(NavContext);
  if (!nav) throw new Error("useNav outside NavProvider");
  return nav;
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

export interface Toast {
  id: number;
  kind: ToastKind;
  title: string;
  body?: string;
}

interface Toaster {
  toasts: Toast[];
  push: (kind: ToastKind, title: string, body?: string) => void;
  dismiss: (id: number) => void;
  fail: (error: unknown, title?: string) => void;
}

const ToastContext = createContext<Toaster | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const seq = useRef(0);
  const dismiss = useCallback((id: number) => setToasts((prev) => prev.filter((toast) => toast.id !== id)), []);
  const push = useCallback(
    (kind: ToastKind, title: string, body?: string) => {
      seq.current += 1;
      const id = seq.current;
      setToasts((prev) => [...prev.slice(-4), { id, kind, title, body }]);
      setTimeout(() => dismiss(id), kind === "error" ? 9000 : 4500);
    },
    [dismiss],
  );
  const fail = useCallback((error: unknown, title = "That did not work") => push("error", title, errorText(error)), [push]);
  const value = useMemo(() => ({ toasts, push, dismiss, fail }), [toasts, push, dismiss, fail]);
  return <ToastContext.Provider value={value}>{children}</ToastContext.Provider>;
}

export function useToast(): Toaster {
  const toaster = useContext(ToastContext);
  if (!toaster) throw new Error("useToast outside ToastProvider");
  return toaster;
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
