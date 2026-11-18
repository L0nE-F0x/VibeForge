import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { phoneReach, readReach, serveCommand } from "../../src/core/phone-reach.js";
import { qrCode, qrPath } from "../../src/shared/qr.js";

type Address = { url: string; code: string } | null;
type Here = { protocol: string; host: string; hostname: string };

/** The phone page's own module (plain JavaScript the browser loads as it is), loaded as the page loads it. */
async function addressModule(): Promise<{ linkCode(hash: string): string; readAddress(typed: string, here: Here): Address }> {
  const file = pathToFileURL(path.join(import.meta.dirname, "../../companion/js/address.js")).href;
  return import(/* @vite-ignore */ file);
}

const CODE = "vf_0123456789abcdef0123456789abcdef";
const onTailnet: Here = { protocol: "https:", host: "desktop.tail1234.ts.net", hostname: "desktop.tail1234.ts.net" };
const onComputer: Here = { protocol: "http:", host: "127.0.0.1:4737", hostname: "127.0.0.1" };

describe("another computer's address, as typed on the phone", () => {
  it("takes a name, an address or the whole link, and completes a name with the page's own tailnet", async () => {
    const { readAddress } = await addressModule();
    const laptop = { url: "https://laptop.tail1234.ts.net", code: "" };
    for (const typed of ["laptop", " Laptop ", "laptop.tail1234.ts.net", "https://laptop.tail1234.ts.net", "https://laptop.tail1234.ts.net/", "LAPTOP.tail1234.ts.net/"]) {
      expect(readAddress(typed, onTailnet), typed).toEqual(laptop);
    }
    // Tailscale Serve on another port than 443.
    expect(readAddress("laptop:8443", onTailnet)).toEqual({ url: "https://laptop.tail1234.ts.net:8443", code: "" });
    // The link Settings → Phone shows carries the code.
    expect(readAddress(`https://laptop.tail1234.ts.net/#pair=${CODE}`, onTailnet)).toEqual({ url: "https://laptop.tail1234.ts.net", code: CODE });
    expect(readAddress(`laptop/#pair=${CODE}`, onTailnet)).toEqual({ url: "https://laptop.tail1234.ts.net", code: CODE });
  });

  it("knows the computer the page came from, and takes nothing the page may not ask", async () => {
    const { readAddress } = await addressModule();
    expect(readAddress("desktop", onTailnet)).toEqual({ url: "", code: "" });
    expect(readAddress("https://desktop.tail1234.ts.net/", onTailnet)).toEqual({ url: "", code: "" });
    for (const typed of ["", "   ", "laptop.tail9999.ts.net", "https://evil.example", "http://laptop.tail1234.ts.net", "laptop.tail1234.ts.net.evil.example", "a.b.tail1234.ts.net", "100.101.102.103", "http://127.0.0.1:4738", "ftp://laptop", "laptop evil"]) {
      expect(readAddress(typed, onTailnet), typed).toBeNull();
    }
  });

  it("lets a page opened on the computer itself add another local port, and only that", async () => {
    const { readAddress } = await addressModule();
    expect(readAddress("127.0.0.1:4738", onComputer)).toEqual({ url: "http://127.0.0.1:4738", code: "" });
    expect(readAddress("http://localhost:4738/", onComputer)).toEqual({ url: "http://localhost:4738", code: "" });
    expect(readAddress("127.0.0.1:4737", onComputer)).toEqual({ url: "", code: "" });
    for (const typed of ["laptop", "https://laptop.tail1234.ts.net", "https://127.0.0.1:4738", "192.168.1.20:4737"]) expect(readAddress(typed, onComputer), typed).toBeNull();
  });

  it("reads the pairing code out of a link, and nothing that only looks like one", async () => {
    const { linkCode } = await addressModule();
    expect(linkCode(`#pair=${CODE}`)).toBe(CODE);
    expect(linkCode(`pair=${CODE}`)).toBe(CODE);
    for (const hash of ["", "#", "#pair=", "#pair=vf_123", `#pair=${CODE}0`, `#pair=${CODE.toUpperCase()}`, `#code=${CODE}`, `#pair=${CODE}&x=1`]) expect(linkCode(hash), hash).toBe("");
  });
});

describe("the QR code in Settings → Phone", () => {
  it("draws the code other encoders draw for the same link, module for module", () => {
    // Checked against python-qrcode (byte mode, level M, mask 4), and read back by ZXing.
    const expected = [
      "1111111010011111101111111",
      "1000001000101100001000001",
      "1011101000111011001011101",
      "1011101010000111001011101",
      "1011101010110101101011101",
      "1000001011110010001000001",
      "1111111010101010101111111",
      "0000000010000010000000000",
      "1000101110110001011111001",
      "1010100000100101010011010",
      "0001111000001011011101100",
      "1000000101001001010100110",
      "0010001001100110011101111",
      "1010110010101011100010010",
      "0011111010111111110111100",
      "0011110100010101000110110",
      "1110001000001101111111100",
      "0000000010000110100010000",
      "1111111010100000101010000",
      "1000001000101010100011110",
      "1011101010010110111111111",
      "1011101001101000011100111",
      "1011101001011111111001010",
      "1000001001010100001111110",
      "1111111011001101011000111",
    ];
    expect(qrCode("https://example.test")?.map((row) => row.map((dark) => (dark ? "1" : "0")).join(""))).toEqual(expected);
  });

  it("grows with the text, keeps its three corner squares, and gives up past what it can hold", () => {
    const link = `https://desktop.tail1234.ts.net/#pair=${CODE}`;
    const sizes = [1, 14, 15, 26, 27, 42, 43, 62, 63, 84, 85, 106, 107, 122, 123, 152, 153, 180, 181, 213].map((length) => qrCode("x".repeat(length))?.length);
    expect(sizes).toEqual([21, 21, 25, 25, 29, 29, 33, 33, 37, 37, 41, 41, 45, 45, 49, 49, 53, 53, 57, 57]);
    expect(qrCode("x".repeat(214))).toBeNull();
    const modules = qrCode(link);
    expect(modules?.length).toBe(37);
    if (!modules) return;
    const size = modules.length;
    const corner = (left: number, top: number) => Array.from({ length: 7 }, (_, y) => modules[top + y].slice(left, left + 7).map((dark) => (dark ? "#" : ".")).join(""));
    const finder = ["#######", "#.....#", "#.###.#", "#.###.#", "#.###.#", "#.....#", "#######"];
    expect(corner(0, 0)).toEqual(finder);
    expect(corner(size - 7, 0)).toEqual(finder);
    expect(corner(0, size - 7)).toEqual(finder);
    // The one module every code has dark, beside the bottom-left square.
    expect(modules[size - 8][8]).toBe(true);
  });

  it("draws each run of dark modules as one bar, inside a quiet border", () => {
    expect(qrPath([[true, true, false], [false, false, true]], 4)).toBe("M4,4h2v1h-2zM6,5h1v1h-1z");
    expect(qrPath([[false]], 4)).toBe("");
  });
});

describe("where a phone can open the page, as Tailscale tells it", () => {
  const status = (state: string, name = "Desktop.tail1234.ts.net.") => JSON.stringify({ BackendState: state, Self: { DNSName: name } });
  const serve = (host: string, proxy: string, funnel = false) =>
    JSON.stringify({ TCP: { 443: { HTTPS: true } }, Web: { [host]: { Handlers: { "/": { Proxy: proxy } } } }, ...(funnel ? { AllowFunnel: { [host]: true } } : {}) });

  it("says which step is left: no Tailscale, not connected, not shared, or the address", () => {
    expect(readReach(null, null, 4737)).toEqual({ tailscale: "missing", name: null, url: null, funnel: false });
    expect(readReach(status("NeedsLogin"), "{}", 4737)).toEqual({ tailscale: "off", name: null, url: null, funnel: false });
    expect(readReach(status("Stopped"), "{}", 4737).tailscale).toBe("off");
    expect(readReach("not json", "", 4737).tailscale).toBe("off");
    expect(readReach(status("Running"), "{}", 4737)).toEqual({ tailscale: "on", name: "desktop.tail1234.ts.net", url: null, funnel: false });
    expect(readReach(status("Running"), "", 4737).url).toBeNull();
    expect(readReach(status("Running"), serve("desktop.tail1234.ts.net:443", "http://127.0.0.1:4737"), 4737)).toEqual({
      tailscale: "on",
      name: "desktop.tail1234.ts.net",
      url: "https://desktop.tail1234.ts.net",
      funnel: false,
    });
  });

  it("only counts what shares the phone page's own port, keeps another port in the address, and says when it is on the internet", () => {
    // Something else of the person's is shared on this computer: not the phone page.
    expect(readReach(status("Running"), serve("desktop.tail1234.ts.net:443", "http://127.0.0.1:3000"), 4737).url).toBeNull();
    expect(readReach(status("Running"), serve("desktop.tail1234.ts.net:443", "http://127.0.0.1:47370"), 4737).url).toBeNull();
    expect(readReach(status("Running"), serve("desktop.tail1234.ts.net:8443", "http://localhost:4737"), 4737).url).toBe("https://desktop.tail1234.ts.net:8443");
    expect(readReach(status("Running"), serve("desktop.tail1234.ts.net:443", "http://127.0.0.1:4737", true), 4737)).toMatchObject({ url: "https://desktop.tail1234.ts.net", funnel: true });
    // A page shared under a path of its own would not load: the page asks for its files from the top.
    const under = JSON.stringify({ Web: { "desktop.tail1234.ts.net:443": { Handlers: { "/phone": { Proxy: "http://127.0.0.1:4737" } } } } });
    expect(readReach(status("Running"), under, 4737).url).toBeNull();
  });

  it("asks the tailscale on this computer, and says so when there is none", async () => {
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), "vibeforge-tailscale-"));
    // A stand-in that answers the two questions the way the real one does.
    fs.writeFileSync(
      path.join(bin, "tailscale"),
      `#!/bin/sh\nif [ "$1" = status ]; then echo '${status("Running")}'; else echo '${serve("desktop.tail1234.ts.net:443", "http://127.0.0.1:4737")}'; fi\n`,
      { mode: 0o755 },
    );
    expect(await phoneReach(4737, { PATH: `${bin}:/usr/bin:/bin` })).toEqual({ tailscale: "on", name: "desktop.tail1234.ts.net", url: "https://desktop.tail1234.ts.net", funnel: false });
    expect((await phoneReach(5000, { PATH: `${bin}:/usr/bin:/bin` })).url).toBeNull();
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "vibeforge-no-tailscale-"));
    expect(await phoneReach(4737, { PATH: empty })).toEqual({ tailscale: "missing", name: null, url: null, funnel: false });
  });

  it("shows the one command that shares the page, for its own port", () => {
    expect(serveCommand(4737)).toBe("sudo tailscale serve --bg --https=443 http://127.0.0.1:4737");
    expect(serveCommand(5000)).toContain("http://127.0.0.1:5000");
  });
});
