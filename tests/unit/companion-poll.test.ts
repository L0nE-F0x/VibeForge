import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** The phone page's module that talks to the computer: requests and the poll. */
const page = fs.readFileSync(path.join(import.meta.dirname, "../../companion/js/api.js"), "utf8");

/** A top-level function of the phone page, as written there, without its `export`. */
function pick(name: string): string {
  const found = page.match(new RegExp(`^(export )?(async )?function ${name}\\([\\s\\S]*?^}$`, "m"))?.[0];
  if (!found) throw new Error(`api.js has no function ${name}`);
  return found.replace(/^export /, "");
}

/** A top-level `const` or `let` line of the phone page. */
function line(kind: "const" | "let", name: string): string {
  const found = page.match(new RegExp(`^${kind} ${name} = .*$`, "m"))?.[0];
  if (!found) throw new Error(`api.js has no ${kind} ${name}`);
  return found;
}

type Answer = { ms: number; status?: number; body?: unknown; etag?: string; text?: string };

/** The page's own poll, run on its own against a link that answers as slowly as `answer` says. */
function pagePoll(answer: (route: string, headers: Record<string, string>) => Answer, opts: { plans?: boolean } = {}) {
  const fetches: Array<{ route: string; at: number; aborted: boolean }> = [];
  let open = 0;
  let most = 0;
  const started = Date.now();
  const fetch = (route: string, init: { signal?: AbortSignal; headers?: Record<string, string> }) =>
    new Promise((resolve, reject) => {
      const reply = answer(route, init.headers ?? {});
      const seen = { route, at: Date.now() - started, aborted: false };
      fetches.push(seen);
      open += 1;
      most = Math.max(most, open);
      const status = reply.status ?? 200;
      const done = setTimeout(() => {
        open -= 1;
        resolve({
          ok: status >= 200 && status < 300,
          status,
          headers: { get: (name: string) => (name === "ETag" ? (reply.etag ?? null) : null) },
          json: async () => {
            if (reply.text !== undefined) throw new SyntaxError("Unexpected token");
            return reply.body ?? (route === "/api/desk" ? { workspaces: [] } : {});
          },
        });
      }, reply.ms);
      init.signal?.addEventListener("abort", () => {
        clearTimeout(done);
        open -= 1;
        seen.aborted = true;
        reject(new Error("aborted"));
      });
    });
  const script = [
    // What the page's modules share (companion/js/state.js), and what api.js keeps to itself.
    `const state = { token: "vf_test", view: "desk", ticket: 0, desk: null, session: null, orch: null, error: "", actionError: "", busy: false, orchDraft: "", plans: null, sessionQuery: { ptyId: "", runId: "" } };`,
    `const parts = {};`,
    `let timer = 0; let plansAt = ${opts.plans ? 0 : "Infinity"}; const PLANS_EVERY_MS = 60000; let updates = 0; let reloads = 0;`,
    `const t = (key) => key;`,
    `function forget() { state.token = ""; }`,
    `function watch() {}`,
    `function show() { state.ticket += 1; }`,
    `function update() { updates += 1; }`,
    `function wordsLoaded() { return true; }`,
    `function loadWords() { return Promise.resolve(true); }`,
    ...["POLL_MS", "POLL_SLOWEST_MS", "POLL_TIMEOUT_MS", "GATEWAY_DOWN", "seen"].map((name) => line("const", name)),
    ...["polling", "pollAgain", "pollFailures", "version"].map((name) => line("let", name)),
    ...["call", "refresh", "poll", "schedule", "loadPlans", "pageIdle", "checkVersion", "withBusy"].map(pick),
    `globalThis.page = { refresh, withBusy, state: () => ({ desk: state.desk, plans: state.plans, error: state.error, actionError: state.actionError, pollFailures, updates, reloads }), setView(next) { state.view = next; show(); void refresh(); }, set(patch) { Object.assign(state, patch); } };`,
  ].join("\n");
  const context = vm.createContext({
    window: {
      setTimeout: (run: () => void, ms: number) => setTimeout(run, ms),
      clearTimeout: (id: NodeJS.Timeout) => clearTimeout(id),
      location: { reload: () => vm.runInContext("reloads += 1", context) },
    },
    fetch,
    AbortController,
  });
  vm.runInContext(script, context);
  const handle = context.page as {
    refresh(): Promise<void>;
    withBusy(task: () => Promise<unknown>): Promise<unknown>;
    setView(view: string): void;
    set(patch: Record<string, unknown>): void;
    state(): { desk: unknown; plans: unknown; error: string; actionError: string; pollFailures: number; updates: number; reloads: number };
  };
  return { page: handle, fetches, most: () => most, open: () => open };
}

describe("the phone page's poll", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps the page changing on a link slower than two seconds: one poll at a time, each one shown", async () => {
    const link = pagePoll(() => ({ ms: 3000 }));
    void link.page.refresh();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(link.most()).toBe(1);
    expect(link.page.state().desk).toEqual({ workspaces: [] });
    // Three seconds to answer, two to the next: one poll every five seconds.
    expect(link.fetches.map((seen) => seen.at)).toEqual([0, 5000, 10_000, 15_000, 20_000, 25_000, 30_000]);
    expect(link.page.state().updates).toBe(6);
  });

  it("doesn't start a second poll when one is asked for while one is out: it follows straight after", async () => {
    const link = pagePoll(() => ({ ms: 1000 }));
    void link.page.refresh();
    await vi.advanceTimersByTimeAsync(300);
    // A sent prompt, the phone unlocked, and a change of page, all while the first poll is out.
    void link.page.refresh();
    void link.page.refresh();
    link.page.setView("session");
    await vi.advanceTimersByTimeAsync(700);
    expect(link.open()).toBe(1);
    await vi.advanceTimersByTimeAsync(4300);
    expect(link.most()).toBe(1);
    expect(link.fetches.map((seen) => `${seen.at} ${seen.route.split("?")[0]}`)).toEqual([
      "0 /api/desk",
      // The first poll's answer was for the page before; the next one starts as it ends.
      "1000 /api/desk",
      "2000 /api/session",
      "5000 /api/desk",
    ]);
  });

  it("gives up on a poll that hangs, says the computer is offline, and backs off until it answers", async () => {
    let down = true;
    const link = pagePoll(() => (down ? { ms: 100_000_000 } : { ms: 100 }));
    void link.page.refresh();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(link.fetches[0].aborted).toBe(true);
    expect(link.page.state()).toMatchObject({ error: "phone.offline", pollFailures: 1 });
    await vi.advanceTimersByTimeAsync(90_000);
    // Each gives up after 15 s; the wait before the next grows from 2 s to 16 s at most.
    expect(link.fetches.map((seen) => seen.at)).toEqual([0, 19_000, 42_000, 73_000, 104_000]);
    down = false;
    await vi.advanceTimersByTimeAsync(33_000);
    expect(link.page.state()).toMatchObject({ error: "", pollFailures: 0 });
    expect(link.fetches.slice(5).map((seen) => seen.at)).toEqual([135_000, 137_100]);
    expect(link.most()).toBe(1);
  });

  it("keeps the desk when the session page's own read is refused, says why, and asks again without backing off", async () => {
    let gone = true;
    const link = pagePoll((route) => (route.startsWith("/api/session") && gone ? { ms: 100, status: 404, body: { error: "That session is gone." } } : { ms: 100 }));
    link.page.setView("session");
    await vi.advanceTimersByTimeAsync(300);
    // The computer answered: the desk is fresh and the banner says what it said about the session.
    expect(link.page.state()).toMatchObject({ desk: { workspaces: [] }, error: "That session is gone.", pollFailures: 0 });
    await vi.advanceTimersByTimeAsync(4200);
    // Two seconds after each poll, as when all is well, not the four, eight… of an offline computer.
    expect(link.fetches.filter((seen) => seen.route === "/api/desk").map((seen) => seen.at)).toEqual([0, 2200, 4400]);
    gone = false;
    await vi.advanceTimersByTimeAsync(2400);
    expect(link.page.state()).toMatchObject({ error: "", pollFailures: 0 });
    expect(link.most()).toBe(1);
  });
  it("keeps what an action ran into on the banner through the polls that follow", async () => {
    const link = pagePoll(() => ({ ms: 50 }));
    void link.page.refresh();
    await vi.advanceTimersByTimeAsync(100);
    await link.page.withBusy(() => Promise.reject(new Error("Atlas is already running in Notes.")));
    await vi.advanceTimersByTimeAsync(10_000);
    // Several good polls later, it is still there; the poll's own error is clear.
    expect(link.fetches.length).toBeGreaterThan(3);
    expect(link.page.state()).toMatchObject({ error: "", actionError: "Atlas is already running in Notes." });
    // The next action starts clean.
    await link.page.withBusy(() => Promise.resolve(true));
    expect(link.page.state().actionError).toBe("");
  });

  it("shows the desk without waiting for plan limits that are slow to come", async () => {
    const link = pagePoll((route) => (route === "/api/plans" ? { ms: 12_000, body: { plans: { providers: [] } } } : { ms: 100 }), { plans: true });
    void link.page.refresh();
    await vi.advanceTimersByTimeAsync(300);
    expect(link.page.state().desk).toEqual({ workspaces: [] });
    expect(link.page.state().plans).toBe(null);
    await vi.advanceTimersByTimeAsync(4000);
    // Polls kept coming every two seconds while plan limits were still on their way.
    expect(link.fetches.filter((seen) => seen.route === "/api/desk").length).toBeGreaterThanOrEqual(3);
    await vi.advanceTimersByTimeAsync(8000);
    expect(link.page.state().plans).toEqual({ providers: [] });
  });

  it("reads a proxy's answer that isn't the computer's (VibeForge closed behind Tailscale Serve) as offline, and backs off", async () => {
    const link = pagePoll(() => ({ ms: 50, status: 502, text: "Bad Gateway" }));
    void link.page.refresh();
    await vi.advanceTimersByTimeAsync(100);
    expect(link.page.state()).toMatchObject({ error: "phone.offline", pollFailures: 1 });
    await vi.advanceTimersByTimeAsync(12_100);
    // 4 s, then 8 s between polls, as for a computer that doesn't answer, not every two seconds.
    expect(link.fetches.map((seen) => seen.at)).toEqual([0, 4050, 12_100]);
  });

  it("sends the tag of what it has, and keeps it when the computer says nothing changed", async () => {
    const heard: string[] = [];
    let first = true;
    const link = pagePoll((_route, headers) => {
      heard.push(headers["If-None-Match"] ?? "");
      if (first) {
        first = false;
        return { ms: 50, body: { workspaces: [{ id: "w" }] }, etag: 'W/"one"' };
      }
      return { ms: 50, status: 304 };
    });
    void link.page.refresh();
    await vi.advanceTimersByTimeAsync(2200);
    expect(heard).toEqual(["", 'W/"one"']);
    expect(link.page.state()).toMatchObject({ desk: { workspaces: [{ id: "w" }] }, error: "", pollFailures: 0 });
  });

  it("loads the page again once the computer runs another version, but never over words still being typed", async () => {
    let version = "2.15.0";
    const link = pagePoll(() => ({ ms: 50, body: { workspaces: [], version } }));
    void link.page.refresh();
    await vi.advanceTimersByTimeAsync(100);
    version = "2.16.0";
    link.page.set({ orchDraft: "start claude in shop and" });
    await vi.advanceTimersByTimeAsync(4200);
    expect(link.page.state().reloads).toBe(0);
    link.page.set({ orchDraft: "" });
    await vi.advanceTimersByTimeAsync(2200);
    expect(link.page.state().reloads).toBeGreaterThan(0);
  });
});
