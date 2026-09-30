/** A press on the mic shorter than this is a click: it keeps listening until the next click. */
export const MIC_TAP_MS = 350;

/**
 * What letting go of the mic does. A short press that started a recording keeps it listening
 * (click to start, click to stop); a hold, or the press that ends a latched recording, finishes it.
 */
export function micRelease(press: { at: number; started: boolean }, now: number): "latch" | "finish" {
  return press.started && now - press.at < MIC_TAP_MS ? "latch" : "finish";
}
