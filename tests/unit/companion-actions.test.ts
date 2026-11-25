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

type PageState = { base: string; token: string; view: string; busy: boolean; error: string };

describe("pairing from the phone", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** The page's own pair(), run on its own against a computer that answers as `fetch` does. */
  function pairing(fetch: (route: string, init: { signal?: AbortSignal; body?: string }) => Promise<unknown>, kept: Record<string, string> = {}) {
    const script = [
      `const state = { base: "", token: "", view: "pair", busy: false, error: "" };`,
      // What the phone keeps of its computers (state.js), as the page reads and writes it.
      ...["TOKEN_KEY", "NAME_KEY", "COMPUTERS_KEY", "otherComputers", "computers", "saveComputer"].map((name) => pick("state.js", name)),
      `const t = (key) => key;`,
      `function update() {}`,
      `function forget() { throw new Error("pairing never forgets"); }`,
      `function forgetSeen() {}`,
      `function setView(next) { state.view = next; }`,
      `function followLink() { return false; }`,
      `const seen = new Map();`,
      ...["POLL_TIMEOUT_MS", "GATEWAY_DOWN", "call", "checkCode", "keyFrom"].map((name) => pick("api.js", name)),
      pick("home.js", "shownComputer"),
      pick("home.js", "pair"),
      `globalThis.page = { pair, state };`,
    ].join("\n");
    const stored = new Map<string, string>(Object.entries(kept));
    const localStorage = { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => stored.set(key, value), removeItem: (key: string) => stored.delete(key) };
    const context = vm.createContext({ window: timers, fetch, AbortController, localStorage });
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

  it("says the computer can't be reached, not that the code is wrong, when something in between answers (VibeForge closed)", async () => {
    const { page } = pairing(() => Promise.resolve({ ok: false, status: 502, json: async () => JSON.parse("<html>Bad Gateway</html>") }));
    await page.pair("vf_right");
    expect(page.state).toMatchObject({ error: "phone.offline", busy: false, token: "" });
    const empty = pairing(() => Promise.resolve({ ok: false, status: 503, json: async () => ({}) }));
    await empty.page.pair("vf_right");
    expect(empty.page.state.error).toBe("phone.offline");
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
    // A computer from 3.6.3 on hands the phone a key of its own, kept instead of the code (D18).
    const key = `vfd_${"ab".repeat(24)}`;
    answer = reply(200, { ok: true, key });
    await page.pair("vf_right");
    expect(page.state).toMatchObject({ token: key });
    expect(stored.get("vibeforge-phone")).toBe(key);
  });

  it("keeps a code with the computer it is for, under the name that computer gives", async () => {
    const laptop = "https://laptop.tail1234.ts.net";
    const asked: string[] = [];
    // The desktop the page came from is paired; the laptop was added and has lost its code (a new one was made there).
    const { page, stored } = pairing(
      (route) => {
        asked.push(route);
        return reply(200, { ok: true, computer: "Laptop" });
      },
      { "vibeforge-phone": "vf_desktop", "vibeforge-computers": JSON.stringify([{ url: laptop, token: "", name: "" }]) },
    );
    page.state.base = laptop;
    await page.pair("vf_laptop");
    expect(asked).toEqual([`${laptop}/api/pair`]);
    expect(page.state).toMatchObject({ error: "", token: "vf_laptop", view: "home" });
    expect(JSON.parse(stored.get("vibeforge-computers") ?? "[]")).toEqual([{ url: laptop, token: "vf_laptop", name: "Laptop" }]);
    // The desktop's own code is untouched.
    expect(stored.get("vibeforge-phone")).toBe("vf_desktop");
  });
});

describe("a link that opens the phone page at one place (the Android widget's)", () => {
  type LinkState = { base: string; token: string; view: string; focusTurn: string; sessionQuery: { ptyId: string; runId: string }; session: unknown };

  /** The page's own followLink(), on a page opened at `href`, with what the phone keeps. */
  function opened(href: string, kept: Record<string, string> = {}, base = "") {
    const script = [
      `const state = { base: ${JSON.stringify(base)}, token: "", view: "home", focusTurn: "", sessionQuery: { ptyId: "", runId: "" }, session: {} };`,
      ...["TOKEN_KEY", "NAME_KEY", "COMPUTERS_KEY", "otherComputers", "computers"].map((name) => pick("state.js", name)),
      `const switched = [];`,
      `function showComputer(url) { switched.push(url); state.base = url; }`,
      pick("pages.js", "LINK_VIEWS"),
      pick("pages.js", "followLink"),
      `globalThis.page = { followLink, state, switched };`,
    ].join("\n");
    const stored = new Map<string, string>(Object.entries(kept));
    const localStorage = { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => stored.set(key, value), removeItem: (key: string) => stored.delete(key) };
    const address = { href };
    const window = { location: address, history: { replaceState: (_s: unknown, _t: string, to: string) => (address.href = new URL(to, address.href).href) } };
    const context = vm.createContext({ window, localStorage, URL });
    vm.runInContext(script, context);
    return { page: context.page as { followLink(): boolean; state: LinkState; switched: string[] }, address };
  }

  const home = "https://desktop.tail1234.ts.net";
  const paired = { "vibeforge-phone": `vfd_${"ab".repeat(24)}` };

  it("opens the plan waiting for Go in the Orchestrator, and takes the link out of the address", () => {
    const { page, address } = opened(`${home}/?view=maestro&turn=t42`, paired);
    expect(page.followLink()).toBe(true);
    expect(page.state).toMatchObject({ view: "maestro", focusTurn: "t42" });
    expect(address.href).toBe(`${home}/`);
  });

  it("opens a session, the Orchestrator or the desk", () => {
    const session = opened(`${home}/?ptyId=p7&runId=r9`, paired);
    expect(session.page.followLink()).toBe(true);
    expect(session.page.state).toMatchObject({ view: "session", sessionQuery: { ptyId: "p7", runId: "r9" }, session: null });
    for (const [view, page] of [["maestro", "maestro"], ["viby", "maestro"], ["desk", "desk"]]) {
      const link = opened(`${home}/?view=${view}`, paired);
      expect(link.page.followLink(), view).toBe(true);
      expect(link.page.state.view, view).toBe(page);
    }
  });

  it("waits for pairing: unpaired, the link stays in the address for pair() to follow", () => {
    const { page, address } = opened(`${home}/?view=maestro&turn=t42`);
    expect(page.followLink()).toBe(false);
    expect(page.state).toMatchObject({ view: "home", focusTurn: "" });
    expect(address.href).toBe(`${home}/?view=maestro&turn=t42`);
  });

  it("is about the computer the page came from, even while the phone shows another", () => {
    const { page } = opened(`${home}/?view=desk`, paired, "https://laptop.tail1234.ts.net");
    expect(page.followLink()).toBe(true);
    expect(page.switched).toEqual([""]);
    expect(page.state).toMatchObject({ base: "", view: "desk" });
  });

  it("leaves a page with no link, or a view it doesn't know, as it was", () => {
    for (const href of [`${home}/`, `${home}/?view=widget`, `${home}/?view=pair`]) {
      const { page } = opened(href, paired);
      expect(page.followLink(), href).toBe(false);
      expect(page.state.view, href).toBe("home");
    }
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

describe("an action from the phone on a link that stalls", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("gives the buttons back after a minute, and says the computer may still be doing it", async () => {
    const script = [
      `const state = { token: "vf", view: "desk", busy: false, error: "", actionError: "" }; const seen = new Map();`,
      `const t = (key) => key;`,
      `function update() {} function show() {} function refresh() {} function forget() {}`,
      ...["ACTION_TIMEOUT_MS", "GATEWAY_DOWN", "call", "post", "withBusy"].map((name) => pick("api.js", name)),
      `globalThis.page = { tap: () => withBusy(() => post("/api/launch", { workspaceId: "w" })), state };`,
    ].join("\n");
    const fetch = (_route: string, init: { signal?: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    const context = vm.createContext({ window: timers, fetch, AbortController });
    vm.runInContext(script, context);
    const page = context.page as { tap(): Promise<unknown>; state: { busy: boolean; actionError: string } };
    const done = page.tap();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(page.state.busy).toBe(true);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await done).toBe(false);
    expect(page.state).toMatchObject({ busy: false, actionError: "phone.timedOut" });
  });

  it("gives a recording a minute to be heard, and longer for a long one", () => {
    const page = fs.readFileSync(path.join(dir, "mic.js"), "utf8");
    const found = page.match(/^export function hearTimeout\([\s\S]*?^}$/m)?.[0].replace(/^export /, "");
    const hearTimeout = vm.runInNewContext(`${found}; hearTimeout`) as (bytes: number) => number;
    expect(hearTimeout(32_000)).toBe(60_000);
    // Three minutes of 16 kHz speech, 5.76 MB: 50 KB/s up, plus half a minute for whisper.
    expect(hearTimeout(16_000 * 2 * 180)).toBe(145_200);
  });
});

describe("Go on a plan card from the phone", () => {
  it("doesn't start the plan when a change typed on the card didn't reach the computer, and says why", async () => {
    const script = [
      `const state = { busy: false, error: "", actionError: "", view: "maestro" }; const parts = { stickTurns: false };`,
      `const posted = [];`,
      `function post(route, body) { posted.push(route); return route.endsWith("/step") ? Promise.reject(new Error("That plan has already been carried out.")) : Promise.resolve({ ok: true }); }`,
      `function update() {} function show() {} function refresh() {}`,
      `function leaveCard() {}`,
      pick("plan-card.js", "pendingSteps"),
      `let stepQueue = Promise.resolve(); const stepSends = new Set();`,
      pick("api.js", "withBusy"),
      pick("plan-card.js", "editStep"),
      pick("plan-card.js", "goPlan"),
      `globalThis.page = { edit: () => editStep({ id: "t" }, { id: "s" }, { prompt: "new words" }).catch(() => undefined), go: () => goPlan({ id: "t" }, {}), state, posted };`,
    ].join("\n");
    const context = vm.createContext({});
    vm.runInContext(script, context);
    const page = context.page as { edit(): Promise<void>; go(): Promise<void>; state: { busy: boolean; actionError: string }; posted: string[] };
    void page.edit();
    await page.go();
    expect(page.posted).toEqual(["/api/orchestrator/step"]);
    expect(page.state).toMatchObject({ busy: false, actionError: "That plan has already been carried out." });
  });
});

describe("a plan card's boxes, typed through an input method", () => {
  /** The card's name and branch boxes (plan-card.js), with nodes that only keep their listeners. */
  function boxes() {
    const script = [
      `const sent = []; let blurs = 0;`,
      `function el(tag, attrs, ...children) { const node = { tag, value: "", children, listeners: {}, addEventListener(type, run) { (this.listeners[type] ||= []).push(run); }, blur() { blurs += 1; for (const run of this.listeners.blur || []) run(); } }; return node; }`,
      `function glyph() { return null; }`,
      `const t = (key) => key;`,
      `function currentStep() { return ""; }`,
      `function editStep(turn, step, patch) { sent.push(patch); }`,
      pick("plan-card.js", "textField"),
      pick("plan-card.js", "branchField"),
      `globalThis.page = { name: () => textField({ id: "t" }, { id: "s" }, "name", "", "Name").children[0], branch: () => branchField({ id: "t" }, { id: "s" }, "").children.find((node) => node && node.tag === "input"), sent, blurs: () => blurs };`,
    ].join("\n");
    const context = vm.createContext({});
    vm.runInContext(script, context);
    return context.page as { name(): FakeBox; branch(): FakeBox; sent: Array<Record<string, string>>; blurs(): number };
  }
  type FakeBox = { value: string; listeners: Record<string, Array<(event: unknown) => void>> };
  /** Enter, as a phone's keyboard sends it: picking a word the input method offered, or Enter itself. */
  function enter(box: FakeBox, patch: { isComposing: boolean; keyCode: number }) {
    for (const run of box.listeners.keydown ?? []) run({ key: "Enter", ...patch, preventDefault() {} });
  }

  it("keeps the box open while Enter only picks the input method's word, and leaves it on Enter itself", () => {
    for (const which of ["name", "branch"] as const) {
      const page = boxes();
      const box = page[which]();
      box.value = "とうきょう";
      // Chrome and Firefox: Enter while the word is still being put together.
      enter(box, { isComposing: true, keyCode: 229 });
      // Safari: the word is in, and the Enter that put it there still comes as 229.
      box.value = "東京";
      enter(box, { isComposing: false, keyCode: 229 });
      expect(page.blurs(), which).toBe(0);
      expect(page.sent, which).toEqual([]);
      enter(box, { isComposing: false, keyCode: 13 });
      expect(page.blurs(), which).toBe(1);
      expect(page.sent, which).toEqual([{ [which]: "東京" }]);
    }
  });
});
