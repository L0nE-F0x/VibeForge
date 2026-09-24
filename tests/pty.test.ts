import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import readline from "node:readline";
import { afterEach, describe, expect, it } from "vitest";
import { markStopRequested } from "../src/core/runfiles.js";
import { spawnManagedPty, type ManagedPty } from "../src/pty/host.js";
import { startPromptedSession } from "../src/pty/launch.js";

const live: ManagedPty[] = [];
const kids: { kill: () => void }[] = [];

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "forgedesk-pty-"));
}

function alive(pid: number): boolean {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const state = stat.split(")")[1]?.trim().split(/\s+/)[0];
    return state === "R" || state === "S" || state === "D";
  } catch {
    return false;
  }
}

async function waitFor(read: () => string, needle: string): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < 8000) {
    if (read().includes(needle)) return;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error(`Timed out waiting for ${needle}. Have: ${read().slice(-400)}`);
}

afterEach(async () => {
  for (const pty of live.splice(0)) {
    try {
      pty.kill();
    } catch {
      /* already gone */
    }
  }
  for (const kid of kids.splice(0)) kid.kill();
  await new Promise((resolve) => setTimeout(resolve, 2200));
});

describe("pty launcher", () => {
  it("keeps two panes in their own cwd and does not mix input", async () => {
    const left = tempDir();
    const right = tempDir();
    const a = spawnManagedPty({
      cwd: left,
      argv: ["/bin/bash", "--noprofile", "--norc", "-i"],
    });
    const b = spawnManagedPty({
      cwd: right,
      argv: ["/bin/bash", "--noprofile", "--norc", "-i"],
    });
    live.push(a, b);
    a.write("pwd\n");
    b.write("pwd\n");
    await waitFor(() => a.snapshot().text, left);
    await waitFor(() => b.snapshot().text, right);
    a.write("echo PANE_A_ONLY\n");
    b.write("echo PANE_B_ONLY\n");
    await waitFor(() => a.snapshot().text, "PANE_A_ONLY");
    await waitFor(() => b.snapshot().text, "PANE_B_ONLY");
    expect(a.snapshot().text).not.toContain("PANE_B_ONLY");
    expect(b.snapshot().text).not.toContain("PANE_A_ONLY");
    expect(a.cwd).toBe(left);
    expect(b.cwd).toBe(right);
  });

  it("records preamble.md and scrollback for a prompted launch, then stops the process group", async () => {
    const cwd = tempDir();
    const dataRoot = tempDir();
    const preamble = "echo FORGEDESK_PREAMBLE_OK\n";
    const session = await startPromptedSession({
      dataRoot,
      cwd,
      argv: ["/bin/bash", "--noprofile", "--norc", "-i"],
      preamble,
      origin: "code",
      slug: "code",
      meta: { prompt: "echo FORGEDESK_PREAMBLE_OK" },
    });
    live.push(session.pty);
    expect(fs.readFileSync(path.join(session.runDir, "preamble.md"), "utf8")).toBe(preamble);
    await waitFor(() => session.pty.snapshot().text, "FORGEDESK_PREAMBLE_OK");
    expect(fs.readFileSync(path.join(session.runDir, "scrollback.txt"), "utf8")).toContain("FORGEDESK_PREAMBLE_OK");

    markStopRequested(session.runDir);
    session.pty.kill();
    await session.finalized;
    expect(alive(session.pid)).toBe(false);
    expect(fs.existsSync(path.join(session.runDir, "scrollback.txt"))).toBe(true);
    const meta = JSON.parse(fs.readFileSync(path.join(session.runDir, "meta.json"), "utf8")) as { status: string };
    expect(meta.status).toBe("stopped");
    expect(fs.readFileSync(path.join(session.runDir, "git.txt"), "utf8").trim()).toBe("not a git repo");
  });

  it("stops a sleep through the shipped pty server", async () => {
    const cwd = tempDir();
    const dataRoot = tempDir();
    const child = spawn(process.execPath, [path.resolve("src/pty/server.js")], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    kids.push(child);
    const rl = readline.createInterface({ input: child.stdout });
    const lines: string[] = [];
    const waitLine = (pred: (value: Record<string, unknown>) => boolean) =>
      new Promise<Record<string, unknown>>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("server timed out")), 8000);
        const check = () => {
          for (const line of lines) {
            const msg = JSON.parse(line) as Record<string, unknown>;
            if (pred(msg)) {
              clearTimeout(timer);
              resolve(msg);
              return true;
            }
          }
          return false;
        };
        if (check()) return;
        rl.on("line", (line) => {
          lines.push(line);
          check();
        });
      });
    rl.on("line", (line) => lines.push(line));
    await waitLine((msg) => msg.event === "ready");
    child.stdin.write(
      JSON.stringify({
        op: "startPrompted",
        reqId: "1",
        dataRoot,
        cwd,
        argv: ["/bin/bash", "-c", "sleep 300"],
        preamble: "sleep",
        origin: "code",
        slug: "sleep",
        meta: { prompt: "sleep" },
      }) + "\n",
    );
    const started = await waitLine((msg) => msg.reqId === "1" && msg.ok === true);
    const runDir = String(started.runDir);
    expect(fs.existsSync(path.join(runDir, "preamble.md"))).toBe(true);
    child.stdin.write(JSON.stringify({ op: "kill", reqId: "2", ptyId: started.ptyId, runDir }) + "\n");
    await waitLine((msg) => msg.event === "exit" && msg.ptyId === started.ptyId);
    const meta = JSON.parse(fs.readFileSync(path.join(runDir, "meta.json"), "utf8")) as { status: string };
    expect(meta.status).toBe("stopped");
    expect(fs.existsSync(path.join(runDir, "scrollback.txt"))).toBe(true);
    child.stdin.end();
  });
});
