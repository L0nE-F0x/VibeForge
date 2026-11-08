import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const dir = path.join(import.meta.dirname, "../../companion/js");

/** A top-level function or `const` of one of the phone page's modules, as written there, without its `export`. */
function pick(file: string, name: string): string {
  const page = fs.readFileSync(path.join(dir, file), "utf8");
  const found = page.match(new RegExp(`^(export )?(async )?function ${name}\\([\\s\\S]*?^}$`, "m"))?.[0] ?? page.match(new RegExp(`^(export )?const ${name} = .*$`, "m"))?.[0];
  if (!found) throw new Error(`${file} has no ${name}`);
  return found.replace(/^export /, "");
}

/** Timers the page sets on `window`, made when it asks, so fake timers stand in. */
const timers = { setTimeout: (run: () => void, ms: number) => setTimeout(run, ms), clearTimeout: (id: NodeJS.Timeout) => clearTimeout(id) };

type PageState = { token: string; view: string; busy: boolean; error: string };

describe("pairing from the phone", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** The page's own pair(), run on its own against a computer that answers as `fetch` does. */
  function pairing(fetch: (route: string, init: { signal?: AbortSignal; body?: string }) => Promise<unknown>) {
    const script = [
      `const state = { token: "", view: "pair", busy: false, error: "" }; const TOKEN_KEY = "vibeforge-phone";`,
      `const t = (key) => key;`,
      `function update() {}`,
      `function forget() { throw new Error("pairing never forgets"); }`,
      `function forgetSeen() {}`,
      `function setView(next) { state.view = next; }`,
      ...["POLL_TIMEOUT_MS", "call", "checkCode"].map((name) => pick("api.js", name)),
      pick("home.js", "pair"),
      `globalThis.page = { pair, state };`,
    ].join("\n");
    const stored = new Map<string, string>();
    const context = vm.createContext({ window: timers, fetch, AbortController, localStorage: { setItem: (key: string, value: string) => stored.set(key, value) } });
    vm.runInContext(script, context);
    return { page: context.page as { pair(code: string): Promise<void>; state: PageState }, stored };
  }

  const reply = (status: number, body: unknown) => Promise.resolve({ ok: status < 400, status, json: async () => body });

  it("says the computer is offline, in the phone's words, when it can't be reached", async () => {
    const { page, stored } = pairing(() => Promise.reject(new TypeError("Failed to fetch")));
    await page.pair(" vf_code ");
    expect(page.state).toMatchObject({ error: "phone.offline", busy: false, token: "", view: "pair" });
    expect(stored.size).toBe(0);
  });

  it("gives up on a link that doesn't answer, so Continue comes back", async () => {
    const { page } = pairing(
      (_route, init) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    );
    void page.pair("vf_code");
    await vi.advanceTimersByTimeAsync(1000);
    expect(page.state.busy).toBe(true);
    await vi.advanceTimersByTimeAsync(14_000);
    expect(page.state).toMatchObject({ error: "phone.offline", busy: false, token: "" });
  });

  it("keeps a code the computer takes, and says why one is refused", async () => {
    const asked: string[] = [];
    let answer = reply(401, { error: "That code is not the one on this computer." });
    const { page, stored } = pairing((route, init) => {
      asked.push(`${route} ${init.body}`);
      return answer;
    });
    await page.pair("vf_wrong");
    expect(page.state).toMatchObject({ error: "That code is not the one on this computer.", busy: false, token: "" });
    answer = reply(401, {});
    await page.pair("vf_wrong");
    expect(page.state.error).toBe("phone.codeWrong");
    answer = reply(200, { ok: true });
    await page.pair(" vf_right ");
    expect(page.state).toMatchObject({ error: "", busy: false, token: "vf_right", view: "home" });
    expect(stored.get("vibeforge-phone")).toBe("vf_right");
    expect(asked.at(-1)).toBe('/api/pair {"token":"vf_right"}');
  });
});

describe("sending the next instruction from the phone", () => {
  type Box = { value: string };
  type Parts = { prompt: Box; stick: boolean };

  /** The page's own sendText() and withBusy(), with the computer's answer held until `answer`. */
  function sending() {
    const script = [
      `const state = { busy: false, error: "", view: "session", session: { state: "waiting", ptyId: "pa", runId: "ra" }, sessionQuery: { ptyId: "pa", runId: "ra" } };`,
      `let parts = { prompt: { value: "Run the tests." }, stick: false };`,
      `let answer; const sent = [];`,
      `function post(route, body) { sent.push(body); return new Promise((resolve) => { answer = resolve; }); }`,
      `const t = (key) => key;`,
      `function update() {}`,
      `function show() {}`,
      `function refresh() {}`,
      pick("api.js", "withBusy"),
      pick("session.js", "sendText"),
      // What tapping Send does, and what opening another session does to the page on show.
      `globalThis.page = { send: () => sendText(parts.prompt.value), open(query, next) { state.sessionQuery = query; parts = next; }, answer: (result) => answer(result), state, sent, parts: () => parts };`,
    ].join("\n");
    const context = vm.createContext({ window: { confirm: () => true } });
    vm.runInContext(script, context);
    return context.page as {
      send(): Promise<void>;
      open(query: { ptyId: string; runId: string }, next: Parts): void;
      answer(result: { ptyId: string; runId: string }): void;
      state: { sessionQuery: { ptyId: string; runId: string }; busy: boolean };
      sent: Array<{ text: string }>;
      parts(): Parts;
    };
  }

  it("clears its own box once the instruction has gone through, and follows the session it went to", async () => {
    const page = sending();
    const box = page.parts().prompt;
    const done = page.send();
    expect(page.sent[0].text).toBe("Run the tests.");
    page.answer({ ptyId: "pa2", runId: "ra" });
    await done;
    expect(box.value).toBe("");
    expect(page.parts().stick).toBe(true);
    expect(page.state.sessionQuery).toEqual({ ptyId: "pa2", runId: "ra" });
  });

  it("leaves another session's box, and which session is on show, alone when the answer comes after a change of page", async () => {
    const page = sending();
    const box = page.parts().prompt;
    const done = page.send();
    // Back, and another session opened, with something typed in its box, before the computer answers.
    const other = { prompt: { value: "Not sent yet." }, stick: false };
    page.open({ ptyId: "pb", runId: "" }, other);
    page.answer({ ptyId: "pa2", runId: "ra" });
    await done;
    expect(other.prompt.value).toBe("Not sent yet.");
    expect(other.stick).toBe(false);
    expect(page.state.sessionQuery).toEqual({ ptyId: "pb", runId: "" });
    expect(box.value).toBe("");
    expect(page.state.busy).toBe(false);
  });
});
