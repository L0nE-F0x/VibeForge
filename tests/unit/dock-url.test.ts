import { describe, expect, it } from "vitest";
import { isDockUrl, normalizeDockInput, savedDockUrl } from "../../src/shared/dock-url.js";

describe("dock addresses", () => {
  it("accepts only http and https", () => {
    expect(isDockUrl("http://127.0.0.1:5173")).toBe(true);
    expect(isDockUrl("HTTPS://example.com/a")).toBe(true);
    expect(isDockUrl("")).toBe(false);
    expect(isDockUrl("localhost:5173")).toBe(false);
    expect(isDockUrl("about:blank")).toBe(false);
    expect(isDockUrl("chrome-error://chromewebdata/")).toBe(false);
    expect(isDockUrl("file:///tmp/index.html")).toBe(false);
  });

  it("turns a typed local host into http and anything else into https", () => {
    expect(normalizeDockInput("  localhost:5173/app ")).toBe("http://localhost:5173/app");
    expect(normalizeDockInput("127.0.0.1:3000")).toBe("http://127.0.0.1:3000");
    expect(normalizeDockInput("0.0.0.0:8080")).toBe("http://0.0.0.0:8080");
    expect(normalizeDockInput("[::1]:5173")).toBe("http://[::1]:5173");
    expect(normalizeDockInput("example.com")).toBe("https://example.com");
    expect(normalizeDockInput("https://example.com")).toBe("https://example.com");
    expect(normalizeDockInput("")).toBe("");
    expect(normalizeDockInput("   ")).toBe("");
  });

  it("does not save a navigation for workspace A onto workspace B", () => {
    expect(savedDockUrl("alpha", "beta", "https://alpha.example", "https://old")).toBeNull();
    expect(savedDockUrl("alpha", "alpha", "https://alpha.example", "https://old")).toBe("https://alpha.example");
    expect(savedDockUrl("alpha", "alpha", "https://same.example", "https://same.example")).toBeNull();
    expect(savedDockUrl("alpha", "alpha", "about:blank", "")).toBeNull();
    expect(savedDockUrl("alpha", "alpha", "chrome-error://chromewebdata/", "https://old")).toBeNull();
    expect(savedDockUrl("alpha", "alpha", "file:///tmp/x", "")).toBeNull();
  });
});
