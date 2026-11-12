import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";

// Electron's network stack isn't here; every test hands in its own fetch.
const netFetch = vi.fn<(url: string, init: RequestInit) => Promise<Response>>();
vi.mock("electron", () => ({ net: { fetch: (url: string, init: RequestInit) => netFetch(url, init) } }));

const { downloadFiles } = await import("../../electron/download.js");
const { MODEL_CATALOG, modelUrl, PIPER_COMMIT, VOICE_CATALOG, voiceUrls, WHISPER_COMMIT } = await import("../../src/core/voice.js");

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "vibeforge-download-"));
}

/** A response that streams `bytes` bytes of `fill` in 64 KB chunks, failing after `failAfter` if given. */
function response(bytes: number, opts: { fill?: number; failAfter?: number } = {}): Response {
  let sent = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (opts.failAfter !== undefined && sent >= opts.failAfter) {
        controller.error(new Error("connection reset"));
        return;
      }
      if (sent >= bytes) {
        controller.close();
        return;
      }
      const size = Math.min(64 * 1024, bytes - sent);
      controller.enqueue(new Uint8Array(size).fill(opts.fill ?? 7));
      sent += size;
    },
  });
  return new Response(body, { headers: { "content-length": String(bytes) } });
}

/** A file of `bytes` bytes of `fill` at `url`, pinned to what it should be; `sha256` overrides the real hash. */
function pinned(url: string, target: string, bytes: number, opts: { fill?: number; sha256?: string } = {}) {
  const sha256 = opts.sha256 ?? createHash("sha256").update(Buffer.alloc(bytes, opts.fill ?? 7)).digest("hex");
  return { url, target, bytes, sha256 };
}

/** Rejects if `work` hasn't settled in `ms`: the bug this guards against was a download that never ended. */
function within<T>(work: Promise<T>, ms = 5000): Promise<T> {
  return Promise.race([work, new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`still waiting after ${ms} ms`)), ms))]);
}

const options = (extra: Partial<Parameters<typeof downloadFiles>[1]> = {}) => ({
  signal: new AbortController().signal,
  progress: () => undefined,
  ...extra,
});

describe("downloading models and voices", () => {
  it("writes each file into place through a .part file and reports progress", async () => {
    const dir = tempDir();
    const target = path.join(dir, "models", "ggml-tiny.bin");
    const seen: number[] = [];
    const bytes = await downloadFiles([pinned("https://example.test/tiny.bin", target, 300_000)], options({ fetch: async () => response(300_000), progress: (received) => seen.push(received) }));
    expect(bytes).toBe(300_000);
    expect(fs.statSync(target).size).toBe(300_000);
    expect(fs.existsSync(`${target}.part`)).toBe(false);
    expect(seen.at(-1)).toBe(300_000);
  });

  it.skipIf(!fs.existsSync("/dev/full"))("ends with the disk's error when the disk is full, instead of waiting forever", async () => {
    const dir = tempDir();
    const target = path.join(dir, "ggml-base.bin");
    const work = downloadFiles([pinned("https://example.test/base.bin", target, 8 * 1024 * 1024, { sha256: "0".repeat(64) })], options({ fetch: async () => response(8 * 1024 * 1024), open: () => fs.createWriteStream("/dev/full") }));
    await expect(within(work)).rejects.toThrow(/ENOSPC/);
    expect(fs.readdirSync(dir)).toEqual([]);
    // Nothing is left half-done, so the next download goes ahead.
    await within(downloadFiles([pinned("https://example.test/base.bin", target, 1000)], options({ fetch: async () => response(1000) })));
    expect(fs.statSync(target).size).toBe(1000);
  });

  it("ends when the writer fails, whatever it is", async () => {
    const dir = tempDir();
    const broken = () =>
      new Writable({
        highWaterMark: 1,
        write(_chunk, _encoding, callback) {
          setTimeout(() => callback(Object.assign(new Error("EIO: i/o error, write"), { code: "EIO" })), 5);
        },
      });
    const work = downloadFiles([pinned("https://example.test/a.bin", path.join(dir, "a.bin"), 4 * 1024 * 1024, { sha256: "0".repeat(64) })], options({ fetch: async () => response(4 * 1024 * 1024), open: broken }));
    await expect(within(work)).rejects.toThrow(/EIO/);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it("removes the part file and the files before it when the connection drops", async () => {
    const dir = tempDir();
    const model = path.join(dir, "voice.onnx");
    const files = [pinned("https://example.test/voice.onnx", model, 200_000), pinned("https://example.test/voice.onnx.json", `${model}.json`, 500_000, { sha256: "0".repeat(64) })];
    const fetch = async (url: string) => (url.endsWith(".json") ? response(500_000, { failAfter: 128 * 1024 }) : response(200_000));
    await expect(within(downloadFiles(files, options({ fetch })))).rejects.toThrow(/connection reset/);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it("stops at once when asked", async () => {
    const dir = tempDir();
    const abort = new AbortController();
    const target = path.join(dir, "big.bin");
    const work = downloadFiles([pinned("https://example.test/big.bin", target, 64 * 1024 * 1024, { sha256: "0".repeat(64) })], options({ signal: abort.signal, fetch: async () => response(64 * 1024 * 1024), progress: (received) => received > 256 * 1024 && abort.abort() }));
    await expect(within(work)).rejects.toThrow(/abort/i);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it("sends no cookies: a sign-in in the browser dock stays out of a download", async () => {
    const dir = tempDir();
    netFetch.mockResolvedValue(response(1000));
    await downloadFiles([pinned("https://example.test/a.bin", path.join(dir, "a.bin"), 1000)], options());
    expect(netFetch.mock.calls[0][1].credentials).toBe("omit");
  });

  it("names the host and its answer when the server refuses", async () => {
    const work = downloadFiles([pinned("https://huggingface.co/x.bin", path.join(tempDir(), "x.bin"), 2)], options({ fetch: async () => new Response("no", { status: 404, statusText: "Not Found" }) }));
    await expect(work).rejects.toThrow("huggingface.co answered 404 Not Found");
  });

  it("keeps a file only with the size and checksum it was pinned to", async () => {
    const dir = tempDir();
    const target = path.join(dir, "ggml-base.bin");
    const url = "https://example.test/base.bin";
    const refused = /ggml-base\.bin is not the file VibeForge expected/;
    // Other bytes of the right length.
    await expect(downloadFiles([pinned(url, target, 100_000, { fill: 9 })], options({ fetch: async () => response(100_000) }))).rejects.toThrow(refused);
    // Too short.
    await expect(downloadFiles([pinned(url, target, 100_000)], options({ fetch: async () => response(60_000) }))).rejects.toThrow(refused);
    // Too long: refused as soon as it passes the size, not after filling the disk.
    let read = 0;
    const endless = await downloadFiles([pinned(url, target, 100_000)], options({ fetch: async () => response(50 * 1024 * 1024), progress: (received) => (read = received) })).catch((error: Error) => error);
    expect(String(endless)).toMatch(refused);
    expect(read).toBeLessThanOrEqual(100_000);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it("fetches every catalog file from a fixed commit, with its size and SHA-256", () => {
    expect(WHISPER_COMMIT).toMatch(/^[0-9a-f]{40}$/);
    expect(PIPER_COMMIT).toMatch(/^[0-9a-f]{40}$/);
    const pins = [
      ...MODEL_CATALOG.map((choice) => ({ url: modelUrl(choice), pin: choice, mb: choice.mb })),
      ...VOICE_CATALOG.flatMap((choice) => [
        { url: voiceUrls(choice).model, pin: choice.model, mb: choice.mb },
        { url: voiceUrls(choice).config, pin: choice.config, mb: 0 },
      ]),
    ];
    for (const { url, pin, mb } of pins) {
      expect(url).toMatch(new RegExp(`^https://huggingface\\.co/[^/]+/[^/]+/resolve/(${WHISPER_COMMIT}|${PIPER_COMMIT})/`));
      expect(pin.sha256, url).toMatch(/^[0-9a-f]{64}$/);
      expect(pin.bytes, url).toBeGreaterThan(1000);
      // The button's rough size stays near the real one.
      if (mb) expect(Math.abs(pin.bytes / 1_048_576 - mb) / mb, url).toBeLessThan(0.1);
    }
    expect(new Set(pins.map((item) => item.pin.sha256)).size).toBe(pins.length);
  });
});
