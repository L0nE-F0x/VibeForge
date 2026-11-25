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
 * Electron's fetch without the session's cookies (a sign-in elsewhere is no business of a model
 * download's) and without its HTTP cache: Chromium would otherwise keep a second copy of every
 * model, voice and runtime archive in the profile's Cache folder, hundreds of megabytes nothing
 * ever reads again. Electron 45 honours `no-store` (measured: three 20 MB downloads left 63 MB in
 * Cache without it and nothing with it).
 */
export const fetchUncached = (url: string, init: { signal: AbortSignal }): Promise<Response> => net.fetch(url, { ...init, credentials: "omit", cache: "no-store" });

/** The marker, in Chromium's profile folder beside the cache it describes, that says it was cleared. */
export const CACHE_CLEARED_MARK = "vibeforge-download-cache-cleared";

/**
 * Once per profile: empties the default session's HTTP cache, where earlier versions left a
 * copy of every download. Only the HTTP cache: cookies, storage and the browser dock's own
 * `persist:dock` partition are untouched. The marker is written only after the clear succeeds, so
 * a failure tries again on the next start. Resolves to whether it cleared the cache this time.
 */
export async function clearOldDownloadCopies(opts: { profile: string; clearCache: () => Promise<void>; log: { info(message: string): void; warn(message: string): void } }): Promise<boolean> {
  const mark = path.join(opts.profile, CACHE_CLEARED_MARK);
  if (fs.existsSync(mark)) return false;
  try {
    await opts.clearCache();
    fs.writeFileSync(mark, `${new Date().toISOString()}\n`);
    opts.log.info("Cleared the copies of earlier downloads from Chromium's HTTP cache");
    return true;
  } catch (error) {
    opts.log.warn(`Could not clear the copies of earlier downloads from the HTTP cache: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

/**
 * Downloads files one after another into place, each through a .part file that is renamed at the
 * end and removed on failure or abort. A file is kept only with the size and SHA-256 it was
 * pinned to. `progress` gets the bytes so far and the total.
 */
export async function downloadFiles(files: Download[], opts: DownloadOptions): Promise<number> {
  const get = opts.fetch ?? fetchUncached;
  const open = opts.open ?? ((file) => fs.createWriteStream(file));
  const total = files.reduce((sum, file) => sum + file.bytes, 0);
  let received = 0;
  const done: string[] = [];
  try {
    for (const file of files) {
      fs.mkdirSync(path.dirname(file.target), { recursive: true });
      const existedBefore = fs.existsSync(file.target);
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
        if (!existedBefore) done.push(file.target);
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
