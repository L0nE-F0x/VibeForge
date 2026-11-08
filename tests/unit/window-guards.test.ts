import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { isAppPage, relaunchArgs } from "../../electron/guards.js";

describe("the window's own page", () => {
  const file = "/opt/Vibe Forge/dist/index.html";
  const built = { file };
  const own = pathToFileURL(file).href;

  it("lets the built index.html through, with or without a hash or query", () => {
    expect(own).toBe("file:///opt/Vibe%20Forge/dist/index.html");
    expect(isAppPage(own, built)).toBe(true);
    expect(isAppPage(`${own}#/settings`, built)).toBe(true);
    expect(isAppPage(`${own}?x=1`, built)).toBe(true);
    expect(isAppPage("file:///opt/Vibe%20Forge/dist/%69ndex.html", built)).toBe(true);
  });

  it("refuses every other file, a dropped page or one beside it", () => {
    expect(isAppPage("file:///tmp/evil.html", built)).toBe(false);
    expect(isAppPage("file:///opt/Vibe%20Forge/dist/other.html", built)).toBe(false);
    expect(isAppPage("file:///opt/Vibe%20Forge/dist/index.html.evil", built)).toBe(false);
    expect(isAppPage("file:///opt/Vibe%20Forge/dist/../dist/index.html/", built)).toBe(false);
    expect(isAppPage("file:///opt/Vibe%20Forge/dist%2Findex.html", built)).toBe(false);
    expect(isAppPage("file://elsewhere/opt/Vibe%20Forge/dist/index.html", built)).toBe(false);
    expect(isAppPage("file:///opt/Vibe Forge/dist", built)).toBe(false);
  });

  it("refuses web pages, odd schemes and nonsense", () => {
    for (const url of ["https://example.com/index.html", "http://localhost:5173/", "data:text/html,<p>hi</p>", "about:blank", "javascript:alert(1)", "", "not a url"]) {
      expect(isAppPage(url, built), url).toBe(false);
    }
  });

  it("matches the dev server by origin, and only it, while developing", () => {
    const dev = { file, devUrl: "http://localhost:5173/" };
    expect(isAppPage("http://localhost:5173/", dev)).toBe(true);
    expect(isAppPage("http://localhost:5173/src/main.tsx?t=1", dev)).toBe(true);
    expect(isAppPage("http://localhost:5174/", dev)).toBe(false);
    expect(isAppPage("http://localhost.evil.com:5173/", dev)).toBe(false);
    expect(isAppPage("https://localhost:5173/", dev)).toBe(false);
    // The build isn't loaded in development, so its file isn't the page then.
    expect(isAppPage(own, dev)).toBe(false);
    // A file:// "dev server" has no origin to match.
    expect(isAppPage("file:///tmp/evil.html", { file, devUrl: "file:///tmp/" })).toBe(false);
  });
});

describe("restarting", () => {
  it("comes back as a window, even when this copy started hidden at login", () => {
    expect(relaunchArgs(["/usr/lib/electron/electron", "/opt/vibeforge", "--hidden"])).toEqual(["/opt/vibeforge"]);
    expect(relaunchArgs(["/usr/lib/electron/electron", "/opt/vibeforge", "--ozone-platform=wayland"])).toEqual(["/opt/vibeforge", "--ozone-platform=wayland"]);
    expect(relaunchArgs(["/usr/lib/electron/electron"])).toEqual([]);
  });
});
