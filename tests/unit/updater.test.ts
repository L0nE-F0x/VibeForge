import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LogFile } from "../../src/core/log.js";
import { updateCommand, type Release } from "../../src/core/updates.js";

const netFetch = vi.fn<(url: string, init: RequestInit) => Promise<Response>>();
vi.mock("electron", () => ({ net: { fetch: (url: string, init: RequestInit) => netFetch(url, init) } }));

const { Updater } = await import("../../electron/updater.js");

afterEach(() => {
  vi.useRealTimers();
  netFetch.mockReset();
});

function updater(opts: { enabled?: boolean; fetch?: (url: string, init: RequestInit) => Promise<Response>; current?: string; command?: (latest: { tag: string } | null) => string | null } = {}) {
  const log = new LogFile(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "vf-updater-")), "log.txt"));
  return new Updater({
    current: opts.current ?? "2.15.0",
    install: "installer",
    command: opts.command ?? (() => "true"),
    url: "https://api.github.com/repos/x/y/releases/latest",
    log,
    enabled: () => opts.enabled ?? true,
    changed: () => undefined,
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
  });
}

const release = (tag: string) => new Response(JSON.stringify({ tag_name: tag, name: `VibeForge ${tag}`, html_url: "https://x", body: "", published_at: "2026-11-12T00:00:00Z" }));

describe("the update check", () => {
  it("asks nobody while automatic checks are off", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn(async () => release("v9.0.0"));
    const off = updater({ enabled: false, fetch });
    off.start();
    await vi.advanceTimersByTimeAsync(7 * 60 * 60 * 1000);
    off.stop();
    expect(fetch).not.toHaveBeenCalled();
    expect(netFetch).not.toHaveBeenCalled();
  });

  it("asks shortly after start and every six hours while on", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn(async () => release("v2.15.0"));
    const on = updater({ fetch });
    on.start();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000);
    expect(fetch).toHaveBeenCalledTimes(2);
    on.stop();
  });

  it("tells a newer release from an older one, and nothing published from a failure", async () => {
    expect((await updater({ fetch: async () => release("v2.16.0") }).check()).available).toBe(true);
    expect((await updater({ fetch: async () => release("v2.14.1") }).check()).available).toBe(false);
    const none = await updater({ fetch: async () => new Response("{}", { status: 404 }) }).check();
    expect(none).toMatchObject({ latest: null, available: false, error: null });
    const refused = await updater({ fetch: async () => new Response("", { status: 403, statusText: "Forbidden" }) }).check();
    expect(refused.error).toBe("GitHub answered 403 Forbidden");
  });

  it("builds the update command again from each release it reads", async () => {
    const seen: Array<string | null> = [];
    const check = updater({
      fetch: async () => release("v2.16.0"),
      command: (latest) => {
        seen.push(latest?.tag ?? null);
        return latest ? `install ${latest.tag}` : "install latest";
      },
    });
    expect(check.get().command).toBe("install latest");
    expect((await check.check()).command).toBe("install v2.16.0");
    expect(seen).toEqual([null, "v2.16.0"]);
  });

  it("reads the releases skipped since this version when an update is there, and carries on without them", async () => {
    const asked: string[] = [];
    const list = [
      { tag_name: "v2.17.0", body: "**Newest.**" },
      { tag_name: "v2.16.1", body: "**Fixed a thing.**" },
      { tag_name: "v2.16.0", body: "**Added a thing.**" },
      { tag_name: "v2.15.0", body: "**This one.**" },
    ];
    const check = updater({
      fetch: async (url) => {
        asked.push(url);
        return url.endsWith("/latest") ? release("v2.17.0") : new Response(JSON.stringify(list));
      },
    });
    const info = await check.check();
    expect(asked).toEqual(["https://api.github.com/repos/x/y/releases/latest", "https://api.github.com/repos/x/y/releases?per_page=50"]);
    expect(info.between.map((item) => item.version)).toEqual(["2.16.1", "2.16.0"]);
    // Nothing newer: the list isn't asked for.
    asked.length = 0;
    await updater({ current: "2.17.0", fetch: async (url) => (asked.push(url), release("v2.17.0")) }).check();
    expect(asked).toHaveLength(1);
    // The list failing leaves the newest release and its notes.
    const failing = await updater({ fetch: async (url) => (url.endsWith("/latest") ? release("v2.17.0") : new Response("", { status: 500 })) }).check();
    expect(failing).toMatchObject({ available: true, error: null, between: [] });
    const throwing = await updater({
      fetch: async (url) => {
        if (url.endsWith("/latest")) return release("v2.17.0");
        throw new Error("offline");
      },
    }).check();
    expect(throwing).toMatchObject({ available: true, error: null, between: [] });
  });

  it("says when GitHub didn't answer in time", async () => {
    const slow = updater({
      fetch: async () => {
        throw Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
      },
    });
    expect((await slow.check()).error).toBe("GitHub did not answer in time.");
  });

  it("sends no cookies: a sign-in in the browser dock doesn't ride along", async () => {
    netFetch.mockResolvedValue(release("v2.15.0"));
    await updater().check();
    expect(netFetch).toHaveBeenCalledTimes(1);
    const [, init] = netFetch.mock.calls[0];
    expect(init.credentials).toBe("omit");
    expect(new Headers(init.headers).get("User-Agent")).toBe("VibeForge/2.15.0");
  });

  it("refuses installer commands when the release lookup failed or omitted a SHA-256 digest", async () => {
    const sha = "b".repeat(64);
    const makeUpdater = (response: Response) => {
      const log = new LogFile(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "vf-updater-digest-")), "log.txt"));
      return new Updater({
        current: "2.15.0",
        install: "installer",
        command: (latest) => updateCommand("installer", "/opt/vibeforge", undefined, latest as Release | null),
        url: "https://api.github.com/repos/x/y/releases/latest",
        log,
        enabled: () => true,
        changed: () => undefined,
        fetch: async () => response,
      });
    };

    const unsigned = makeUpdater(
      new Response(JSON.stringify({ tag_name: "v2.16.0", assets: [{ name: "install.sh" }] })),
    );
    expect(unsigned.get().command).toBeNull();
    expect((await unsigned.check()).command).toBeNull();

    const verified = makeUpdater(
      new Response(JSON.stringify({ tag_name: "v2.16.0", assets: [{ name: "install.sh", digest: `sha256:${sha}` }] })),
    );
    const info = await verified.check();
    expect(info.command).toContain("--proto =https --proto-redir =https");
    expect(info.command).toContain(sha);
  });
});
