import { describeError } from "../src/core/log.js";
import { TICK_MS } from "../src/core/routines.js";
import type { MainContext } from "./main-context.js";

// What runs on a clock once VibeForge is up, and the one list a quit stops it all from.

/** Run upkeep (compressing ended runs, Settings → Storage) waits for start to settle, then repeats. */
const UPKEEP_FIRST_MS = 2 * 60 * 1000;
const UPKEEP_EVERY_MS = 6 * 60 * 60 * 1000;

/** Timers, intervals and watchers to stop at quit, stopped in the order they were added. */
export class Disposables {
  private readonly stops: Array<() => void> = [];

  add(...stops: Array<() => void>): void {
    this.stops.push(...stops);
  }

  timeout(run: () => void, ms: number): void {
    const timer = setTimeout(run, ms);
    this.stops.push(() => clearTimeout(timer));
  }

  interval(run: () => void, ms: number): void {
    const timer = setInterval(run, ms);
    this.stops.push(() => clearInterval(timer));
  }

  /** Stops everything added so far, once. */
  dispose(): void {
    for (const stop of this.stops.splice(0)) stop();
  }
}

/** The routine scheduler's tick, and run upkeep, on their timers in `timers`. */
export function startSchedules(ctx: MainContext, timers: Disposables): void {
  const { log } = ctx;
  const tick = () =>
    void ctx.service
      ?.tick()
      .then((results) => {
        for (const result of results) if (result.error) log.warn(`Routine ${result.routineId} could not start: ${result.error}`);
      })
      .catch((error: unknown) => {
        console.error(error);
        log.error(`Routine scheduler: ${describeError(error)}`);
      });
  timers.timeout(tick, 3000);
  timers.interval(tick, TICK_MS);
  // Compress finished runs and apply Settings → Storage: shortly after start, then a few times a day.
  const upkeep = () =>
    void ctx.service
      ?.maintainRuns()
      .then((done) => {
        if (done.compressed || done.removed) log.info(`Runs tidied: ${done.compressed} compressed, ${done.removed} removed, ${Math.round(done.freed / 1024 / 1024)} MB freed`);
      })
      .catch((error: unknown) => log.warn(`Run upkeep: ${describeError(error)}`));
  timers.timeout(upkeep, UPKEEP_FIRST_MS);
  timers.interval(upkeep, UPKEEP_EVERY_MS);
}
