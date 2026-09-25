import { net } from "electron";
import { describeError, type LogFile } from "../src/core/log.js";
import { isNewer, releaseFrom, type InstallKind } from "../src/core/updates.js";
import type { UpdateInfo } from "../src/shared/api.js";

const FIRST_CHECK_MS = 20_000;
const EVERY_MS = 6 * 60 * 60 * 1000;

/**
 * Asks GitHub which release is newest: shortly after start and every six hours while automatic
 * checks are on, or whenever someone asks. It only reads the public release list.
 */
export class Updater {
  private info: UpdateInfo;
  private inflight: Promise<UpdateInfo> | null = null;
  private timers: NodeJS.Timeout[] = [];

  constructor(
    private readonly opts: {
      current: string;
      install: InstallKind;
      command: string | null;
      url: string;
      log: LogFile;
      enabled: () => boolean;
      changed: () => void;
    },
  ) {
    this.info = { current: opts.current, latest: null, available: false, checking: false, checkedAt: null, error: null, install: opts.install, command: opts.command };
  }

  get(): UpdateInfo {
    return this.info;
  }

  check(): Promise<UpdateInfo> {
    this.inflight ??= this.fetchLatest().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  start(): void {
    const auto = () => {
      if (this.opts.enabled()) void this.check();
    };
    this.timers.push(setTimeout(auto, FIRST_CHECK_MS), setInterval(auto, EVERY_MS));
  }

  stop(): void {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers = [];
  }

  private set(patch: Partial<UpdateInfo>): void {
    this.info = { ...this.info, ...patch };
    this.opts.changed();
  }

  private async fetchLatest(): Promise<UpdateInfo> {
    this.set({ checking: true });
    try {
      const response = await net.fetch(this.opts.url, {
        headers: { Accept: "application/vnd.github+json", "User-Agent": `VibeForge/${this.opts.current}` },
        signal: AbortSignal.timeout(15_000),
      });
      // 404: nothing has been published yet.
      if (!response.ok && response.status !== 404) throw new Error(`GitHub answered ${response.status} ${response.statusText}`.trim());
      const latest = response.ok ? releaseFrom(await response.json()) : null;
      const available = latest ? isNewer(latest.version, this.opts.current) : false;
      this.set({ latest, available, checking: false, checkedAt: new Date().toISOString(), error: null });
      this.opts.log.info(`Update check: ${latest ? `newest release ${latest.version}` : "no releases published"}, this is ${this.opts.current}${available ? " (update available)" : ""}`);
    } catch (error) {
      const message = error instanceof Error && error.name === "TimeoutError" ? "GitHub did not answer in time." : describeError(error).split("\n")[0];
      this.set({ checking: false, checkedAt: new Date().toISOString(), error: message });
      this.opts.log.warn(`Update check failed: ${message}`);
    }
    return this.info;
  }
}
