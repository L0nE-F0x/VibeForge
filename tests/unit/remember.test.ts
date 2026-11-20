import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { forget, recall, remember, resetPlaces } from "../../src/ui/remember.js";

const isTab = (value: unknown): value is string => typeof value === "string";

describe("where each thing was left", () => {
  const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  let store: Map<string, string>;
  beforeEach(() => {
    store = new Map();
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      writable: true,
      value: {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => store.set(key, value),
      },
    });
    resetPlaces();
  });
  afterEach(() => {
    if (originalStorage) Object.defineProperty(globalThis, "localStorage", originalStorage);
    else Reflect.deleteProperty(globalThis, "localStorage");
    resetPlaces();
  });

  it("keeps each thing's own place, apart from the others and from other scopes", () => {
    remember("agents.tab", "writer", "memory");
    remember("agents.tab", "tester", "chats");
    remember("run.tab", "writer", "changes");
    expect(recall("agents.tab", "writer", isTab)).toBe("memory");
    expect(recall("agents.tab", "tester", isTab)).toBe("chats");
    expect(recall("run.tab", "writer", isTab)).toBe("changes");
    expect(recall("agents.tab", "someone-new", isTab)).toBeUndefined();
  });

  it("survives a restart, and a value that no longer fits is ignored", () => {
    remember("code.side", "ws-1", { open: false, tab: "browser" });
    remember("code.side", "ws-2", 42);
    resetPlaces();
    const isSide = (value: unknown): value is { open: boolean } => typeof (value as { open?: unknown })?.open === "boolean";
    expect(recall("code.side", "ws-1", isSide)).toEqual({ open: false, tab: "browser" });
    expect(recall("code.side", "ws-2", isSide)).toBeUndefined();
  });

  it("forgets a deleted thing, and drops the least recently touched past the limit", () => {
    remember("run.tab", "gone", "details");
    forget("run.tab", "gone");
    expect(recall("run.tab", "gone", isTab)).toBeUndefined();

    for (let i = 0; i < 300; i += 1) remember("run.tab", `run-${i}`, "prompt");
    // Touching the oldest again keeps it; the next oldest goes instead.
    remember("run.tab", "run-0", "transcript");
    remember("run.tab", "run-300", "prompt");
    expect(recall("run.tab", "run-0", isTab)).toBe("transcript");
    expect(recall("run.tab", "run-1", isTab)).toBeUndefined();
    expect(recall("run.tab", "run-300", isTab)).toBe("prompt");
  });

  it("starts empty when the record is broken or storage is gone", () => {
    store.set("vf.place.agents.tab", "{not json");
    expect(recall("agents.tab", "writer", isTab)).toBeUndefined();
    Object.defineProperty(globalThis, "localStorage", { configurable: true, writable: true, value: undefined });
    resetPlaces();
    remember("agents.tab", "writer", "skills");
    expect(recall("agents.tab", "writer", isTab)).toBe("skills");
  });
});
