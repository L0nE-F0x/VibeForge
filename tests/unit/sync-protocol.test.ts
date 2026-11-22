import { describe, expect, it } from "vitest";
import {
  conflictName,
  deviceId,
  firewallCommand,
  dialAddress,
  DISCOVERY_PORT,
  folderType,
  hostPort,
  ignoreLines,
  isOurFolder,
  isSyncMode,
  linkFolderId,
  lockDown,
  machineAddresses,
  mergeIgnoreFile,
  mirrorMode,
  newFolderId,
  pairingCode,
  parsePairingCode,
  shortId,
  SYNC_PORT,
  withoutIgnoreBlock,
} from "../../src/core/sync/protocol.js";

const A = "TIKSU4F-FTL4JMP-6WX2WN7-HAXB57C-6IVGIQ7-U7ZUQKP-KCA2BBD-D7RSEAV";
const B = "MTOM47S-JJWJ5ZV-ILPEULO-TWZVT4L-NH4YGIY-4FU5CNV-NOGQ3O6-VEV56AH";

describe("sync: modes", () => {
  it("mirrors a mode for the other machine and names it for Syncthing", () => {
    expect([mirrorMode("two"), mirrorMode("send"), mirrorMode("receive")]).toEqual(["two", "receive", "send"]);
    expect([folderType("two"), folderType("send"), folderType("receive")]).toEqual(["sendreceive", "sendonly", "receiveonly"]);
    expect([isSyncMode("two"), isSyncMode("both"), isSyncMode(undefined)]).toEqual([true, false, false]);
  });
});

describe("sync: machines and their codes", () => {
  it("tidies a device id however it was pasted, and refuses anything else", () => {
    expect(deviceId(A)).toBe(A);
    expect(deviceId(`  ${A.toLowerCase().replace(/-/g, " ")} `)).toBe(A);
    expect(deviceId(A.replace(/-/g, ""))).toBe(A);
    expect(deviceId(A.slice(0, 40))).toBeNull();
    expect(deviceId("hello")).toBeNull();
    // 0, 1, 8 and 9 aren't in the alphabet Syncthing uses.
    expect(deviceId(A.replace("T", "1"))).toBeNull();
    expect(shortId(A)).toBe("TIKSU4F");
  });

  it("reads an address with or without a port, IPv6 too", () => {
    expect(hostPort("192.168.1.20")).toBe(`192.168.1.20:${SYNC_PORT}`);
    expect(hostPort("192.168.1.20:4000")).toBe("192.168.1.20:4000");
    expect(hostPort("tcp://laptop.tail1234.ts.net:22737")).toBe("laptop.tail1234.ts.net:22737");
    expect(hostPort("fd7a:115c:a1e0::1")).toBe(`[fd7a:115c:a1e0::1]:${SYNC_PORT}`);
    expect(hostPort("[fd7a::1]:4000")).toBe("[fd7a::1]:4000");
    expect(hostPort("[fd7a::1]")).toBe(`[fd7a::1]:${SYNC_PORT}`);
    for (const bad of ["", "a b", "host:99999", "host:0", "host:x", "-host", "a/b", "zz::zz::1"]) expect(hostPort(bad), bad).toBeNull();
    expect(dialAddress("10.0.0.2:22737")).toBe("tcp://10.0.0.2:22737");
  });

  it("makes a pairing code and reads it back", () => {
    const code = pairingCode(A, ["100.64.0.3:22737", "192.168.1.20:22737"]);
    expect(code).toBe(`${A}@100.64.0.3:22737,192.168.1.20:22737`);
    expect(parsePairingCode(code)).toEqual({ id: A, addresses: ["100.64.0.3:22737", "192.168.1.20:22737"] });
    expect(pairingCode(A, [])).toBe(A);
    expect(parsePairingCode(` ${A} `)).toEqual({ id: A, addresses: [] });
    // A bad address is dropped; a bad id is no code at all.
    expect(parsePairingCode(`${A}@nope nope,10.0.0.2,10.0.0.2`)).toEqual({ id: A, addresses: [`10.0.0.2:${SYNC_PORT}`] });
    expect(parsePairingCode("vf_1234@10.0.0.2")).toBeNull();
    expect(parsePairingCode("")).toBeNull();
  });

  it("lists where this machine can be reached: the tailnet first, never loopback or a container's bridge", () => {
    const row = (address: string, family = "IPv4", internal = false) => ({ address, family, internal, netmask: "", mac: "", cidr: null }) as never;
    const found = machineAddresses({
      lo: [row("127.0.0.1", "IPv4", true)],
      wlan0: [row("192.168.1.20"), row("fe80::1", "IPv6")],
      tailscale0: [row("100.101.102.103")],
      docker0: [row("172.17.0.1")],
      "br-abc": [row("172.18.0.1")],
      eth1: [row("169.254.3.4")],
      gone: undefined,
    });
    expect(found).toEqual([`100.101.102.103:${SYNC_PORT}`, `192.168.1.20:${SYNC_PORT}`]);
    expect(machineAddresses({ eth0: [row("10.0.0.5")] }, 4000)).toEqual(["10.0.0.5:4000"]);
  });
});

describe("sync: the firewall", () => {
  const rules = "### tuple ### allow tcp 53317 0.0.0.0/0 any 0.0.0.0/0 in\n-A ufw-user-input -p tcp --dport 53317 -j ACCEPT\n";
  it("names the one command to run when ufw is on and sync's port is shut", () => {
    expect(firewallCommand("# ufw.conf\nENABLED=yes\nLOGLEVEL=low\n", rules)).toBe("sudo ufw allow 22737/tcp && sudo ufw allow 21737/udp");
    expect(firewallCommand("ENABLED=yes\n", rules, 4000, 4001)).toBe("sudo ufw allow 4000/tcp && sudo ufw allow 4001/udp");
  });
  it("says nothing when ufw is off or the port is already open", () => {
    expect(firewallCommand("ENABLED=no\n", rules)).toBeNull();
    expect(firewallCommand("", rules)).toBeNull();
    expect(firewallCommand("ENABLED=yes\n", `${rules}-A ufw-user-input -p tcp --dport 22737 -j ACCEPT\n`)).toBeNull();
    // Another port that merely starts the same isn't it.
    expect(firewallCommand("ENABLED=yes\n", "-A ufw-user-input -p tcp --dport 227370 -j ACCEPT\n")).not.toBeNull();
  });
});

describe("sync: folders", () => {
  it("gives a share a fresh id and two machines one shared link id", () => {
    const id = newFolderId();
    expect(id).toMatch(/^vf-ws-[0-9a-f]{12}$/);
    expect(newFolderId()).not.toBe(id);
    expect(newFolderId(() => Buffer.from("0123456789abcdef", "hex"))).toBe("vf-ws-0123456789ab");
    expect(linkFolderId(A, B)).toBe(linkFolderId(B, A));
    expect(linkFolderId(A, B)).toMatch(/^vf-link-[0-9a-f]{16}$/);
    expect([isOurFolder(id), isOurFolder(linkFolderId(A, B)), isOurFolder("default"), isOurFolder("photos")]).toEqual([true, true, false, false]);
  });

  it("keeps heavy folders, conflict copies and this machine's git bookkeeping out", () => {
    const full = ignoreLines({ filesOnly: false });
    expect(full).toEqual(["(?d)node_modules", "(?d)target", "(?d).venv", "*.sync-conflict-*", ".git/worktrees", ".git/hooks", ".git/config", ".git/*.lock", ".git/**/*.lock", ".git/gc.pid"]);
    const files = ignoreLines({ filesOnly: true });
    expect(files).toContain("(?d).git");
    expect(files).not.toContain(".git/worktrees");
  });

  it("puts its lines in .stignore without losing what someone else wrote there", () => {
    const first = mergeIgnoreFile("", ["(?d)node_modules"]);
    expect(first.split("\n")[1]).toBe("(?d)node_modules");
    const own = mergeIgnoreFile("*.log\nbuild/\n", ["(?d)node_modules"]);
    expect(own.endsWith("*.log\nbuild/\n")).toBe(true);
    // Again with other lines: the block is replaced, not doubled, and the rest stays.
    const again = mergeIgnoreFile(own, ["(?d).git"]);
    expect(again).toContain("(?d).git");
    expect(again).not.toContain("node_modules");
    expect(again.match(/VibeForge sync: end/g)).toHaveLength(1);
    expect(again.endsWith("*.log\nbuild/\n")).toBe(true);
    expect(mergeIgnoreFile(again, ["(?d).git"])).toBe(again);
    expect(withoutIgnoreBlock(again)).toBe("*.log\nbuild/\n");
    expect(withoutIgnoreBlock(first)).toBe("");
    expect(withoutIgnoreBlock("*.log\n")).toBe("*.log\n");
  });

  it("reads Syncthing's name for a copy of a file both machines changed", () => {
    expect(conflictName("notes.sync-conflict-20261117-204452-MTOM47S.md")).toEqual({ original: "notes.md", stamp: "20261117-204452", winner: "MTOM47S" });
    expect(conflictName("index.sync-conflict-20261117-204240-MTOM47S")).toEqual({ original: "index", stamp: "20261117-204240", winner: "MTOM47S" });
    expect(conflictName("a.b.sync-conflict-20261117-204240-MTOM47S.tar")?.original).toBe("a.b.tar");
    expect(conflictName(".env.sync-conflict-20261117-204240-MTOM47S")?.original).toBe(".env");
    expect(conflictName(".sync-conflict-20261117-204452-MTOM47S.env")).toEqual({ original: ".env", stamp: "20261117-204452", winner: "MTOM47S" });
    expect(conflictName(".sync-conflict-20261117-204452-MTOM47S.gitignore")?.original).toBe(".gitignore");
    expect(conflictName(".sync-conflict-20261117-204452-MTOM47S.envrc")?.original).toBe(".envrc");
    for (const other of ["notes.md", "notes.sync-conflict.md", ".sync-conflict-20261117-204240-MTOM47S", ".sync-conflict-20261117-204240-MTOM47S.", "x.sync-conflict-2026-204240-MTOM47S.md", "x.sync-conflict-20261117-204240-mtom47s.md"]) expect(conflictName(other), other).toBeNull();
  });
});

describe("sync: the private Syncthing's settings", () => {
  const xml = `<configuration version="52">
    <gui enabled="true"><address>127.0.0.1:8384</address></gui>
    <options>
        <listenAddress>default</listenAddress>
        <listenAddress>quic://0.0.0.0:22000</listenAddress>
        <globalAnnounceEnabled>true</globalAnnounceEnabled>
        <localAnnounceEnabled>true</localAnnounceEnabled>
        <localAnnouncePort>21027</localAnnouncePort>
        <localAnnounceMCAddr>[ff12::8384]:21027</localAnnounceMCAddr>
        <relaysEnabled>true</relaysEnabled>
        <startBrowser>true</startBrowser>
        <natEnabled>true</natEnabled>
        <urAccepted>3</urAccepted>
        <urURL>https://data.syncthing.net/newdata</urURL>
        <autoUpgradeIntervalH>12</autoUpgradeIntervalH>
        <maxSendKbps>0</maxSendKbps>
    </options>
    <defaults><folder id=""><maxConflicts>10</maxConflicts></folder></defaults>
</configuration>`;
  const option = (text: string, name: string) => [...text.matchAll(new RegExp(`<${name}>([^<]*)</${name}>`, "g"))].map((match) => match[1]);

  it("turns off everything that reaches outside, whatever the file said", () => {
    const locked = lockDown(xml, { listen: "tcp://:22737", discovery: true });
    expect(option(locked, "listenAddress")).toEqual(["tcp://:22737"]);
    expect(option(locked, "globalAnnounceEnabled")).toEqual(["false"]);
    expect(option(locked, "relaysEnabled")).toEqual(["false"]);
    expect(option(locked, "natEnabled")).toEqual(["false"]);
    expect(option(locked, "urAccepted")).toEqual(["-1"]);
    expect(option(locked, "autoUpgradeIntervalH")).toEqual(["0"]);
    expect(option(locked, "startBrowser")).toEqual(["false"]);
    // Not in the file at all: added.
    expect(option(locked, "crashReportingEnabled")).toEqual(["false"]);
    expect(option(locked, "localAnnounceEnabled")).toEqual(["true"]);
    expect(option(locked, "localAnnouncePort")).toEqual([String(DISCOVERY_PORT)]);
    expect(option(locked, "localAnnounceMCAddr")).toEqual([`[ff12::8384]:${DISCOVERY_PORT}`]);
    // What isn't sync's business is left as it was.
    expect(option(locked, "maxSendKbps")).toEqual(["0"]);
    expect(locked).toContain("<address>127.0.0.1:8384</address>");
    expect(locked).toContain("<maxConflicts>10</maxConflicts>");
    // Locking a locked file changes nothing.
    expect(lockDown(locked, { listen: "tcp://:22737", discovery: true })).toBe(locked);
  });

  it("can keep quiet on the local network too, and refuses a file with no options", () => {
    const quiet = lockDown(xml, { listen: "tcp://127.0.0.1:4000", discovery: false, discoveryPort: 4001 });
    expect(option(quiet, "localAnnounceEnabled")).toEqual(["false"]);
    expect(option(quiet, "localAnnouncePort")).toEqual(["4001"]);
    expect(() => lockDown("<configuration></configuration>", { listen: "tcp://:1", discovery: false })).toThrow(/no options/);
  });
});
