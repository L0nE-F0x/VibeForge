import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";

// Electron's network stack isn't here; every test hands in its own fetch.
vi.mock("electron", () => ({ net: {} }));

const { downloadFiles } = await import("../../electron/download.js");

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

/** Rejects if `work` hasn't settled in `ms`: the bug this guards against was a download that never ended. */
function within<T>(work: Promise<T>, ms = 5000): Promise<T> {
  return Promise.race([work, new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`still waiting after ${ms} ms`)), ms))]);
}

const options = (extra: Partial<Parameters<typeof downloadFiles>[1]> = {}) => ({
  signal: new AbortController().signal,
  expected: 0,
  progress: () => undefined,
  ...extra,
});

describe("downloading models and voices", () => {
  it("writes each file into place through a .part file and reports progress", async () => {
    const dir = tempDir();
    const target = path.join(dir, "models", "ggml-tiny.bin");
    const seen: number[] = [];
    const bytes = await downloadFiles([{ url: "https://example.test/tiny.bin", target }], options({ fetch: async () => response(300_000), progress: (received) => seen.push(received) }));
    expect(bytes).toBe(300_000);
    expect(fs.statSync(target).size).toBe(300_000);
    expect(fs.existsSync(`${target}.part`)).toBe(false);
    expect(seen.at(-1)).toBe(300_000);
  });

  it.skipIf(!fs.existsSync("/dev/full"))("ends with the disk's error when the disk is full, instead of waiting forever", async () => {
    const dir = tempDir();
    const target = path.join(dir, "ggml-base.bin");
    const work = downloadFiles([{ url: "https://example.test/base.bin", target }], options({ fetch: async () => response(8 * 1024 * 1024), open: () => fs.createWriteStream("/dev/full") }));
    await expect(within(work)).rejects.toThrow(/ENOSPC/);
    expect(fs.readdirSync(dir)).toEqual([]);
    // Nothing is left half-done, so the next download goes ahead.
    await within(downloadFiles([{ url: "https://example.test/base.bin", target }], options({ fetch: async () => response(1000) })));
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
    const work = downloadFiles([{ url: "https://example.test/a.bin", target: path.join(dir, "a.bin") }], options({ fetch: async () => response(4 * 1024 * 1024), open: broken }));
    await expect(within(work)).rejects.toThrow(/EIO/);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it("removes the part file and the files before it when the connection drops", async () => {
    const dir = tempDir();
    const model = path.join(dir, "voice.onnx");
    const files = [
      { url: "https://example.test/voice.onnx", target: model },
      { url: "https://example.test/voice.onnx.json", target: `${model}.json` },
    ];
    const fetch = async (url: string) => (url.endsWith(".json") ? response(500_000, { failAfter: 128 * 1024 }) : response(200_000));
    await expect(within(downloadFiles(files, options({ fetch })))).rejects.toThrow(/connection reset/);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it("stops at once when asked", async () => {
    const dir = tempDir();
    const abort = new AbortController();
    const target = path.join(dir, "big.bin");
    const work = downloadFiles([{ url: "https://example.test/big.bin", target }], options({ signal: abort.signal, fetch: async () => response(64 * 1024 * 1024), progress: (received) => received > 256 * 1024 && abort.abort() }));
    await expect(within(work)).rejects.toThrow(/abort/i);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it("names the host and its answer when the server refuses", async () => {
    const work = downloadFiles([{ url: "https://huggingface.co/x.bin", target: path.join(tempDir(), "x.bin") }], options({ fetch: async () => new Response("no", { status: 404, statusText: "Not Found" }) }));
    await expect(work).rejects.toThrow("huggingface.co answered 404 Not Found");
  });
});
