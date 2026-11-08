import fs from "node:fs";
import path from "node:path";
import { Readable, type Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { net } from "electron";

export interface DownloadOptions {
  signal: AbortSignal;
  expected: number;
  progress: (received: number, total: number) => void;
  /** Stand-ins for tests: what fetches a URL, and what writes a .part file. */
  fetch?: (url: string, init: { signal: AbortSignal }) => Promise<Response>;
  open?: (file: string) => Writable;
}

/**
 * Downloads files one after another into place, each through a .part file that is renamed at the
 * end and removed on failure or abort. `progress` gets the bytes so far and the expected total.
 */
export async function downloadFiles(files: Array<{ url: string; target: string }>, opts: DownloadOptions): Promise<number> {
  const get = opts.fetch ?? ((url, init) => net.fetch(url, init));
  const open = opts.open ?? ((file) => fs.createWriteStream(file));
  let received = 0;
  let total = opts.expected;
  const done: string[] = [];
  try {
    for (const file of files) {
      fs.mkdirSync(path.dirname(file.target), { recursive: true });
      const partial = `${file.target}.part`;
      try {
        const response = await get(file.url, { signal: opts.signal });
        if (!response.ok || !response.body) throw new Error(`${new URL(file.url).host} answered ${response.status} ${response.statusText}`.trim());
        const length = Number(response.headers.get("content-length"));
        // The first file is the big one; trust its real size over the catalog's guess.
        if (files.length === 1 && length) total = length;
        // pipeline settles on the first error at either end (a full disk, a dropped connection, an
        // abort) and closes both, so a write that fails can't leave the download waiting forever.
        await pipeline(
          Readable.fromWeb(response.body as WebReadableStream<Uint8Array>),
          async function* (chunks: AsyncIterable<Buffer>) {
            for await (const chunk of chunks) {
              received += chunk.length;
              opts.progress(received, Math.max(total, received));
              yield chunk;
            }
          },
          open(partial),
          { signal: opts.signal },
        );
        fs.renameSync(partial, file.target);
        done.push(file.target);
      } finally {
        fs.rmSync(partial, { force: true });
      }
    }
  } catch (error) {
    // Half a voice (a model without its config) is worse than none.
    for (const target of done) fs.rmSync(target, { force: true });
    throw error;
  }
  return received;
}
