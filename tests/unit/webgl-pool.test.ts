import { afterEach, describe, expect, it, vi } from "vitest";
import { type GlUser, WebglPool } from "../../src/ui/webgl-pool.js";

/** A terminal stand-in: records whether it draws with WebGL. */
function terminal(name: string, works = true) {
  const user: GlUser & { name: string; on: boolean; attaches: number } = {
    name,
    on: false,
    attaches: 0,
    attach() {
      user.attaches += 1;
      if (!works) return false;
      user.on = true;
      return true;
    },
    detach() {
      user.on = false;
    },
  };
  return user;
}

/** A pool that settles when told to, so each step is visible. */
function pool(slots: number) {
  const jobs: Array<() => void> = [];
  const gl = new WebglPool(slots, (job) => jobs.push(job));
  const settle = () => {
    while (jobs.length) jobs.shift()!();
  };
  return { gl, settle };
}

const names = (gl: WebglPool) => gl.holders().map((user) => (user as unknown as { name: string }).name).sort();

describe("WebGL pool", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("settles on the browser's own queueMicrotask, which refuses to be called as a method", async () => {
    const real = queueMicrotask;
    vi.stubGlobal("queueMicrotask", function (this: unknown, job: () => void) {
      if (this !== undefined && this !== globalThis) throw new TypeError("Illegal invocation");
      real(job);
    });
    const gl = new WebglPool(1);
    const a = terminal("a");
    expect(() => gl.add(a, true)).not.toThrow();
    await Promise.resolve();
    expect(a.on).toBe(true);
  });

  it("hands out no more slots than it has", () => {
    const { gl, settle } = pool(2);
    for (const name of ["a", "b", "c"]) gl.add(terminal(name), true);
    settle();
    expect(gl.holders()).toHaveLength(2);
  });

  it("gives the slots of hidden terminals to the ones on screen", () => {
    const { gl, settle } = pool(2);
    const [a, b, c, d] = ["a", "b", "c", "d"].map((name) => terminal(name));
    gl.add(a, true);
    gl.add(b, true);
    settle();
    // Another workspace: a and b hide, c and d show.
    gl.show(a, false);
    gl.show(b, false);
    gl.add(c, true);
    gl.add(d, true);
    settle();
    expect(names(gl)).toEqual(["c", "d"]);
    expect([a.on, b.on]).toEqual([false, false]);
  });

  it("lets a hidden terminal keep its slot while nobody on screen needs it", () => {
    const { gl, settle } = pool(3);
    const [a, b] = ["a", "b"].map((name) => terminal(name));
    gl.add(a, true);
    gl.add(b, true);
    settle();
    gl.show(a, false);
    settle();
    expect(names(gl)).toEqual(["a", "b"]);
    gl.show(a, true);
    settle();
    expect(a.attaches).toBe(1);
  });

  it("serves the most recently used terminal on screen first", () => {
    const { gl, settle } = pool(1);
    const [a, b, c] = ["a", "b", "c"].map((name) => terminal(name));
    gl.add(a, true);
    settle();
    gl.add(b, true);
    gl.add(c, true);
    settle();
    expect(names(gl)).toEqual(["a"]);
    gl.touch(b);
    gl.show(a, false);
    settle();
    expect(names(gl)).toEqual(["b"]);
  });

  it("lets go of a terminal that unmounts", () => {
    const { gl, settle } = pool(1);
    const [a, b] = ["a", "b"].map((name) => terminal(name));
    gl.add(a, true);
    gl.add(b, true);
    settle();
    const first = gl.holders()[0] as typeof a;
    gl.remove(first);
    settle();
    expect(first.on).toBe(false);
    expect(gl.holders()).toEqual([first === a ? b : a]);
  });

  it("passes a lost context's slot on and doesn't retry it until it is shown again", () => {
    const { gl, settle } = pool(1);
    const [a, b] = ["a", "b"].map((name) => terminal(name));
    gl.add(a, true);
    settle();
    gl.add(b, true);
    settle();
    a.on = false;
    gl.lost(a);
    settle();
    expect(names(gl)).toEqual(["b"]);
    gl.remove(b);
    settle();
    expect(gl.holders()).toEqual([]);
    gl.show(a, false);
    gl.show(a, true);
    settle();
    expect(names(gl)).toEqual(["a"]);
  });

  it("stops asking a terminal where WebGL fails", () => {
    const { gl, settle } = pool(2);
    const broken = terminal("x", false);
    gl.add(broken, true);
    settle();
    gl.add(terminal("y"), true);
    settle();
    expect(broken.attaches).toBe(1);
    expect(names(gl)).toEqual(["y"]);
  });
});
