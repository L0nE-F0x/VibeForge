import { describe, expect, it } from "vitest";
import { ownerChanges, TRAY_WATCHER } from "../../electron/tray-host.js";

// Captured from dbus-monitor on Omarchy: its own NameAcquired/NameLost first, then the name
// appearing and leaving.
const capture = `signal time=1793116021.407010 sender=org.freedesktop.DBus -> destination=:1.120 serial=4294967295 path=/org/freedesktop/DBus; interface=org.freedesktop.DBus; member=NameAcquired
   string ":1.120"
signal time=1793116021.407021 sender=org.freedesktop.DBus -> destination=:1.120 serial=4294967295 path=/org/freedesktop/DBus; interface=org.freedesktop.DBus; member=NameLost
   string ":1.120"
signal time=1793116021.966249 sender=org.freedesktop.DBus -> destination=(null destination) serial=4294967295 path=/org/freedesktop/DBus; interface=org.freedesktop.DBus; member=NameOwnerChanged
   string "${TRAY_WATCHER}"
   string ""
   string ":1.121"
signal time=1793116022.775370 sender=org.freedesktop.DBus -> destination=(null destination) serial=4294967295 path=/org/freedesktop/DBus; interface=org.freedesktop.DBus; member=NameOwnerChanged
   string "${TRAY_WATCHER}"
   string ":1.121"
   string ""
`;

describe("tray host watch", () => {
  it("reports each new owner of the tray watcher, and its leaving", () => {
    const owners: string[] = [];
    ownerChanges((owner) => owners.push(owner))(capture);
    expect(owners).toEqual([":1.121", ""]);
  });

  it("reads output split anywhere", () => {
    const owners: string[] = [];
    const read = ownerChanges((owner) => owners.push(owner));
    for (let at = 0; at < capture.length; at += 7) read(capture.slice(at, at + 7));
    expect(owners).toEqual([":1.121", ""]);
  });

  it("ignores other names", () => {
    const owners: string[] = [];
    ownerChanges((owner) => owners.push(owner))(capture.replaceAll(TRAY_WATCHER, "org.example.Other"));
    expect(owners).toEqual([]);
  });
});
