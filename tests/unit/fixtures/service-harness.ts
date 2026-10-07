import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect } from "vitest";
import { TeamService, type DeskHost, type Launched, type Queued, type SpawnRequest } from "../../../src/core/team-service.js";

// The service against a PTY host that only records what it is asked, shared by the service tests.

export function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "vibeforge-svc-"));
}

export const INTERVAL = 5 * 60 * 1000;

/** A start that went ahead, not one waiting for its folder. */
export function started(result: Launched | Queued): Launched {
  if ("queued" in result) throw new Error(`Waiting for ${result.behind.join(", ")}`);
  return result;
}

/** A PTY host that records what the service asks of it; tests end processes with `exit`. */
export function setup(opts: { appStartedAt?: Date; configRoot?: string; dataRoot?: string; now?: () => Date } = {}) {
  const configRoot = opts.configRoot ?? tempDir();
  const dataRoot = opts.dataRoot ?? tempDir();
  const place = tempDir();
  fs.mkdirSync(configRoot, { recursive: true });
  fs.writeFileSync(
    path.join(configRoot, "engines.json"),
    JSON.stringify({
      engines: [
        { id: "argy", label: "Argy", bin: "argy", args: ["--flag"], promptArgs: ["{prompt}"], continueArgs: ["--continue"] },
        { id: "pasty", label: "Pasty", bin: "pasty", args: [] },
        { id: "gone", label: "Gone", bin: "gone", args: [] },
      ],
    }),
  );
  const spawns: SpawnRequest[] = [];
  const sent: Array<{ ptyId: string; text: string }> = [];
  const killed: string[] = [];
  const notes: Array<{ title: string; body: string }> = [];
  const ended: Array<{ runId: string; origin: string; outcome: string }> = [];
  const recorded: Array<{ ptyId: string; runDir: string | null }> = [];
  let n = 0;
  let svc: TeamService;
  const host: DeskHost = {
    async spawn(request) {
      n += 1;
      spawns.push(request);
      return { ptyId: `pty-${n}`, pid: 1000 + n };
    },
    async send(ptyId, text) {
      sent.push({ ptyId, text });
    },
    async kill(ptyId) {
      killed.push(ptyId);
      // A killed process reports its exit a moment later, like the real host.
      setTimeout(() => void svc.onPtyExit(ptyId, 0, 1), 5);
    },
    async record(ptyId, runDir) {
      recorded.push({ ptyId, runDir });
    },
    resolveBin: (bin) => (bin === "argy" || bin === "pasty" ? `/usr/bin/${bin}` : null),
    notify: (note) => notes.push(note),
    finished: (run) => ended.push(run),
    snapshotGit: async () => "git status --short\n M a.txt\n\ngit diff --stat\n a.txt | 1 +\n 1 file changed, 1 insertion(+)\n",
    gitHead: async () => "abc1234",
  };
  svc = new TeamService({ configRoot, dataRoot, appStartedAt: opts.appStartedAt ?? new Date(9 * INTERVAL), now: opts.now ?? (() => new Date()), host });
  const exit = (ptyId: string, code = 0) => svc.onPtyExit(ptyId, code, null);
  return { svc, host, spawns, sent, killed, notes, ended, recorded, place, configRoot, dataRoot, exit };
}

/** Wait for work the service queues on its own (a shell's program changing). */
export async function until(check: () => boolean): Promise<void> {
  for (let tries = 0; tries < 200 && !check(); tries += 1) await new Promise((resolve) => setTimeout(resolve, 2));
  expect(check()).toBe(true);
}

export async function agentIn(ctx: ReturnType<typeof setup>, engine = "argy") {
  return ctx.svc.saveAgent({ name: "Notes", brief: "Keep notes.", engine, places: [ctx.place] });
}

