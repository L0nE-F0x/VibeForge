import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";

// One VibeForge per folder. Electron's own lock is per profile (--user-data-dir), so a second copy
// with another profile but the same config and data folders would end the first one's runs at
// start, stop its Syncthing every 30 s, run each routine twice and lose chat updates. Each folder is
// held by listening on an abstract Unix socket named after it: the kernel lets go of it the moment
// the process ends, however it ends, so a crash never leaves a lock behind for anyone to clear.

/** How long a second copy waits for the folders before giving up: a copy that is quitting lets go of them last. */
const WAIT_MS = 2000;
const RETRY_MS = 200;

/** The socket name that holds `folder`: its real path (so a link to it counts as the same folder), hashed. */
export function lockName(folder: string, uid = os.userInfo().uid): string {
  let real = folder;
  try {
    real = fs.realpathSync(folder);
  } catch {
    /* not there yet: its own name, then */
  }
  const hash = crypto.createHash("sha256").update(real).digest("hex").slice(0, 32);
  return `\0vibeforge-${uid}-${hash}`;
}

function listen(name: string): Promise<net.Server | null> {
  return new Promise((resolve, reject) => {
    const server = net.createServer((socket) => socket.destroy());
    server.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "EADDRINUSE") resolve(null);
      else reject(error);
    });
    server.listen(name, () => {
      // Holding the folder must not keep a process alive that is otherwise done.
      server.unref();
      resolve(server);
    });
  });
}

export type FolderHold = { ok: true; release: () => void } | { ok: false; folder: string };

/**
 * Hold every one of `folders` for this process, or none: the first one another VibeForge holds is
 * named. A taken folder is tried again for `waitMs`, as a copy on its way out lets go of it last.
 */
export async function holdFolders(folders: string[], { waitMs = WAIT_MS, retryMs = RETRY_MS }: { waitMs?: number; retryMs?: number } = {}): Promise<FolderHold> {
  const names = [...new Map(folders.map((folder) => [lockName(folder), folder])).entries()];
  const held: net.Server[] = [];
  const release = () => {
    for (const server of held.splice(0)) server.close();
  };
  const until = Date.now() + waitMs;
  for (const [name, folder] of names) {
    let server = await listen(name);
    while (!server && Date.now() < until) {
      await new Promise((resolve) => setTimeout(resolve, retryMs));
      server = await listen(name);
    }
    if (!server) {
      release();
      return { ok: false, folder };
    }
    held.push(server);
  }
  return { ok: true, release };
}
