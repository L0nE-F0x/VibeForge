import { describe, expect, it, vi } from "vitest";
import { noticeToast } from "../../src/ui/notices.js";

describe("what the main process tells the window", () => {
  const buttons = () => ({ copyDiagnostics: vi.fn(), continueAll: vi.fn() });

  it("never puts Continue all or Copy diagnostics on the button Ctrl+Z presses", () => {
    // Ctrl+Z runs the newest toast's action (state.tsx), as Undo; these two aren't an Undo.
    const stopped = buttons();
    const cutOff = noticeToast({ id: "host-stopped", terminals: 2, runIds: ["run-a", "run-b"] }, stopped);
    expect(cutOff).not.toHaveProperty("action");
    expect(cutOff?.extra?.stay).toBe(true);
    const more = cutOff?.extra?.more ?? [];
    expect(more.map((button) => button.label)).toEqual(["Continue all"]);
    more[0].run();
    expect(stopped.continueAll).toHaveBeenCalledWith(["run-a", "run-b"]);

    const failing = buttons();
    const errors = noticeToast({ id: "errors", count: 3 }, failing);
    expect(errors).not.toHaveProperty("action");
    expect(errors?.extra?.more?.map((button) => button.label)).toEqual(["Copy diagnostics"]);
    errors?.extra?.more?.[0].run();
    expect(failing.copyDiagnostics).toHaveBeenCalledTimes(1);
  });

  it("offers Continue all only when something was cut off, and leaves stalling to the window", () => {
    expect(noticeToast({ id: "host-stopped", terminals: 0, runIds: [] }, buttons())?.extra?.more).toBeUndefined();
    expect(noticeToast({ id: "window-reloaded", reason: "crashed" }, buttons())).toMatchObject({ kind: "info" });
    expect(noticeToast({ id: "host-stalled" }, buttons())).toBeNull();
    expect(noticeToast({ id: "host-answering" }, buttons())).toBeNull();
  });
});
