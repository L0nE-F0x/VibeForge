import fs from "node:fs";
import path from "node:path";
import { net } from "electron";

/**
 * Downloads files one after another into place, each through a .part file that is renamed at the
 * end and removed on failure or abort. `progress` gets the bytes so far and the expected total.
 */
export async function downloadFiles(
  files: Array<{ url: string; target: string }>,
  opts: { signal: AbortSignal; expected: number; progress: (received: number, total: number) => void },
): Promise<number> {
  let received = 0;
  let total = opts.expected;
  const done: string[] = [];
  try {
    for (const file of files) {
      fs.mkdirSync(path.dirname(file.target), { recursive: true });
      const partial = `${file.target}.part`;
      try {
        const response = await net.fetch(file.url, { signal: opts.signal });
        if (!response.ok || !response.body) throw new Error(`${new URL(file.url).host} answered ${response.status} ${response.statusText}`.trim());
        const length = Number(response.headers.get("content-length"));
        // The first file is the big one; trust its real size over the catalog's guess.
        if (files.length === 1 && length) total = length;
        const out = fs.createWriteStream(partial);
        const finished = new Promise<void>((resolve, reject) => {
          out.on("finish", resolve);
          out.on("error", reject);
        });
        const reader = response.body.getReader();
        for (;;) {
          const { done: end, value } = await reader.read();
          if (end) break;
          if (!out.write(value)) await new Promise<void>((resolve) => out.once("drain", () => resolve()));
          received += value.length;
          opts.progress(received, Math.max(total, received));
        }
        out.end();
        await finished;
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
