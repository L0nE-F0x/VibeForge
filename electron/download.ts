import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Readable, type Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { net } from "electron";

/** A file to fetch, and the exact size and SHA-256 it must arrive with to be kept. */
export interface Download {
  url: string;
  target: string;
  bytes: number;
  sha256: string;
}

export interface DownloadOptions {
  signal: AbortSignal;
  progress: (received: number, total: number) => void;
  /** Stand-ins for tests: what fetches a URL, and what writes a .part file. */
  fetch?: (url: string, init: { signal: AbortSignal }) => Promise<Response>;
  open?: (file: string) => Writable;
}

/**
 * Downloads files one after another into place, each through a .part file that is renamed at the
 * end and removed on failure or abort. A file is kept only with the size and SHA-256 it was
 * pinned to. `progress` gets the bytes so far and the total.
 */
export async function downloadFiles(files: Download[], opts: DownloadOptions): Promise<number> {
  const get = opts.fetch ?? ((url, init) => net.fetch(url, init));
  const open = opts.open ?? ((file) => fs.createWriteStream(file));
  const total = files.reduce((sum, file) => sum + file.bytes, 0);
  let received = 0;
  const done: string[] = [];
  try {
    for (const file of files) {
      fs.mkdirSync(path.dirname(file.target), { recursive: true });
      const partial = `${file.target}.part`;
      const mismatch = () => new Error(`${path.basename(file.target)} is not the file VibeForge expected (its size or checksum differs), so it was not kept.`);
      try {
        const response = await get(file.url, { signal: opts.signal });
        if (!response.ok || !response.body) throw new Error(`${new URL(file.url).host} answered ${response.status} ${response.statusText}`.trim());
        const hash = createHash("sha256");
        let bytes = 0;
        // pipeline settles on the first error at either end (a full disk, a dropped connection, an
        // abort) and closes both, so a write that fails can't leave the download waiting forever.
        await pipeline(
          Readable.fromWeb(response.body as WebReadableStream<Uint8Array>),
          async function* (chunks: AsyncIterable<Buffer>) {
            for await (const chunk of chunks) {
              bytes += chunk.length;
              // More than the file should hold: stop now rather than fill the disk.
              if (bytes > file.bytes) throw mismatch();
              hash.update(chunk);
              received += chunk.length;
              opts.progress(received, Math.max(total, received));
              yield chunk;
            }
          },
          open(partial),
          { signal: opts.signal },
        );
        if (bytes !== file.bytes || hash.digest("hex") !== file.sha256.toLowerCase()) throw mismatch();
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
