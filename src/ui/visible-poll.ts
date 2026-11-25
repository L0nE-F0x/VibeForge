// A poll that runs only while the window is on screen. Hidden in the tray or behind another
// workspace, it sets no timer at all, so a check that runs a program (tailscale, for one) costs
// nothing while nobody can see its answer.

/** The page's visibility, as `document` reports it; tests hand in their own. */
export interface Visibility {
  readonly hidden: boolean;
  addEventListener(type: "visibilitychange", listener: () => void): void;
  removeEventListener(type: "visibilitychange", listener: () => void): void;
}

/** Runs `work` now and every `ms` while the page is visible, and at once when it comes back. Returns the stop. */
export function pollWhileShown(work: () => void, ms: number, page: Visibility = document): () => void {
  let timer: ReturnType<typeof setInterval> | null = null;
  const pause = () => {
    if (timer === null) return;
    clearInterval(timer);
    timer = null;
  };
  const run = () => {
    work();
    if (timer === null) timer = setInterval(work, ms);
  };
  const changed = () => (page.hidden ? pause() : run());
  page.addEventListener("visibilitychange", changed);
  if (!page.hidden) run();
  return () => {
    pause();
    page.removeEventListener("visibilitychange", changed);
  };
}
