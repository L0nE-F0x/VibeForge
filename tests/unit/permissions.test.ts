import { describe, expect, it } from "vitest";
import { permissionAllowed } from "../../electron/guards.js";

describe("what pages may use", () => {
  it("lets every page copy to the clipboard, and only VibeForge's own page notify", () => {
    expect(permissionAllowed(true, "clipboard-sanitized-write")).toBe(true);
    expect(permissionAllowed(false, "clipboard-sanitized-write")).toBe(true);
    expect(permissionAllowed(true, "notifications")).toBe(true);
    expect(permissionAllowed(false, "notifications")).toBe(false);
  });

  it("refuses everything else, the window's page included", () => {
    for (const permission of ["media", "clipboard-read", "geolocation", "openExternal", "fullscreen", "midi", "hid", "fileSystem", ""]) {
      expect(permissionAllowed(true, permission), permission).toBe(false);
      expect(permissionAllowed(false, permission), permission).toBe(false);
    }
  });
});
