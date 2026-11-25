// The DevTools protocol over the pipe Electron opens with --remote-debugging-pipe (fd 3 in, fd 4
// out, one JSON message per NUL), and over a WebSocket for the main process's Node inspector. No
// TCP port is opened for the window, so two apps never collide and nothing else can attach.

import type { Readable, Writable } from "node:stream";

type Waiter = { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout; method: string };
export type CdpEvent = { method: string; params: Record<string, unknown>; sessionId?: string };

export class PipeCdp {
  private nextId = 0;
  private readonly waiting = new Map<number, Waiter>();
  private readonly listeners = new Set<(event: CdpEvent) => void>();
  private closed = false;

  constructor(
    private readonly out: Writable,
    input: Readable,
  ) {
    let buffer = Buffer.alloc(0);
    input.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      for (let nul = buffer.indexOf(0); nul >= 0; nul = buffer.indexOf(0)) {
        const frame = buffer.subarray(0, nul).toString("utf8");
        buffer = buffer.subarray(nul + 1);
        if (frame) this.receive(frame);
      }
    });
    input.on("close", () => this.dispose("the app closed its DevTools pipe"));
    out.on("error", () => this.dispose("the app's DevTools pipe broke"));
  }

  send<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}, sessionId?: string, timeoutMs = 15_000): Promise<T> {
    if (this.closed) return Promise.reject(new Error(`${method}: the app is gone`));
    const id = ++this.nextId;
    this.out.write(`${JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params })}\0`);
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        reject(new Error(`${method} got no answer in ${timeoutMs} ms`));
      }, timeoutMs);
      this.waiting.set(id, { resolve: resolve as (value: unknown) => void, reject, timer, method });
    });
  }

  on(listener: (event: CdpEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  dispose(why = "closed"): void {
    if (this.closed) return;
    this.closed = true;
    for (const [id, waiter] of this.waiting) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error(`${waiter.method}: ${why}`));
      this.waiting.delete(id);
    }
    this.listeners.clear();
  }

  private receive(raw: string): void {
    const message = JSON.parse(raw) as { id?: number; result?: unknown; error?: { message: string }; method?: string; params?: Record<string, unknown>; sessionId?: string };
    if (message.id !== undefined) {
      const waiter = this.waiting.get(message.id);
      if (!waiter) return;
      clearTimeout(waiter.timer);
      this.waiting.delete(message.id);
      if (message.error) waiter.reject(new Error(`${waiter.method}: ${message.error.message}`));
      else waiter.resolve(message.result);
      return;
    }
    if (message.method) for (const listener of this.listeners) listener({ method: message.method, params: message.params ?? {}, sessionId: message.sessionId });
  }
}

/** The main process's Node inspector (Electron's --inspect), for the few checks that need it. */
export class InspectorCdp {
  private nextId = 0;
  private readonly waiting = new Map<number, Waiter>();

  private constructor(private readonly socket: WebSocket) {
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data)) as { id?: number; result?: unknown; error?: { message: string } };
      const waiter = message.id === undefined ? undefined : this.waiting.get(message.id);
      if (!waiter || message.id === undefined) return;
      clearTimeout(waiter.timer);
      this.waiting.delete(message.id);
      if (message.error) waiter.reject(new Error(`${waiter.method}: ${message.error.message}`));
      else waiter.resolve(message.result);
    });
  }

  static async connect(url: string): Promise<InspectorCdp> {
    const socket = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true });
      socket.addEventListener("error", () => reject(new Error(`Could not reach the main process's inspector at ${url}`)), { once: true });
    });
    return new InspectorCdp(socket);
  }

  send<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}, timeoutMs = 15_000): Promise<T> {
    const id = ++this.nextId;
    this.socket.send(JSON.stringify({ id, method, params }));
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        reject(new Error(`${method} got no answer in ${timeoutMs} ms`));
      }, timeoutMs);
      this.waiting.set(id, { resolve: resolve as (value: unknown) => void, reject, timer, method });
    });
  }

  close(): void {
    for (const [id, waiter] of this.waiting) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error(`${waiter.method}: closed`));
      this.waiting.delete(id);
    }
    try {
      this.socket.close();
    } catch {
      /* already closed */
    }
  }
}

/** A Runtime.evaluate answer: the value, or the page's exception as an Error. */
export function evaluated<T>(result: { result?: { value?: unknown }; exceptionDetails?: { text?: string; exception?: { description?: string } } }): T {
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? "evaluation failed");
  return result.result?.value as T;
}
