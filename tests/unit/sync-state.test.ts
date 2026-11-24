import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildLink, homeHint, readLink, settleWithLink, writeLink, type LinkFile } from "../../src/core/sync/link.js";
import { emptyState, normalizeState, SyncStateFile, type SyncState } from "../../src/core/sync/state.js";

const A = "TIKSU4F-FTL4JMP-6WX2WN7-HAXB57C-6IVGIQ7-U7ZUQKP-KCA2BBD-D7RSEAV";
const B = "MTOM47S-JJWJ5ZV-ILPEULO-TWZVT4L-NH4YGIY-4FU5CNV-NOGQ3O6-VEV56AH";
const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), "vibeforge-sync-state-"));

const state = (shares: Partial<SyncState["shares"][number]>[] = [], extra: Partial<SyncState> = {}): SyncState => ({
  ...emptyState(),
  machines: [{ id: B, name: "Lap", addresses: [] }],
  shares: shares.map((share, index) => ({ folderId: `vf-ws-00000000000${index}`, machineId: B, path: `/home/me/Projects/p${index}`, name: `P${index}`, mode: "two" as const, filesOnly: false, rev: 1, ...share })),
  ...extra,
});

describe("sync: what is saved", () => {
  it("keeps only what is well formed", () => {
    const clean = normalizeState({
      machines: [{ id: B.toLowerCase(), name: " Lap ", addresses: ["10.0.0.2", "bad address", "10.0.0.2"] }, { id: B, name: "again" }, { id: "nope" }, null],
      shares: [
        { folderId: "vf-ws-0123456789ab", machineId: B, path: "/home/me/site", name: "", mode: "sideways", filesOnly: "yes", rev: 0 },
        { folderId: "vf-ws-0123456789ab", machineId: B, path: "/home/me/again" },
        { folderId: "photos", machineId: B, path: "/home/me/photos" },
        { folderId: "vf-ws-aaaaaaaaaaaa", machineId: A, path: "/home/me/unpaired" },
        { folderId: "vf-ws-bbbbbbbbbbbb", machineId: B, path: "relative/path" },
      ],
      stopped: { "vf-ws-cccccccccccc": B, "vf-ws-dddddddddddd": "nobody", other: B },
      ignored: [A, A, "x"],
    });
    expect(clean.machines).toEqual([{ id: B, name: "Lap", addresses: ["10.0.0.2:22737"] }]);
    expect(clean.shares).toEqual([{ folderId: "vf-ws-0123456789ab", machineId: B, path: "/home/me/site", name: "site", mode: "two", filesOnly: false, rev: 1 }]);
    expect(clean.stopped).toEqual({ "vf-ws-cccccccccccc": B });
    expect(clean.ignored).toEqual([A]);
    expect(normalizeState(null)).toEqual(emptyState());
    expect(normalizeState("text")).toEqual(emptyState());
  });

  it("reads, changes and writes its file", () => {
    const file = path.join(temp(), "sync", "state.json");
    const store = new SyncStateFile(file);
    expect(store.read()).toEqual(emptyState());
    store.update((next) => {
      next.machines.push({ id: B, name: "Lap", addresses: ["10.0.0.2:22737"] });
      return next;
    });
    expect(new SyncStateFile(file).read().machines[0].name).toBe("Lap");
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });
});

describe("sync: the note two machines keep between them", () => {
  it("says what this machine shares with that one, what it stopped and what runs here", () => {
    const mine = state([{ mode: "send", filesOnly: true, rev: 3 }, { machineId: A }], { stopped: { "vf-ws-eeeeeeeeeeee": B, "vf-ws-ffffffffffff": A } });
    const link = buildLink({ id: A, name: "Desk" }, mine, B, { "vf-ws-000000000000": ["Claude Code"], "vf-ws-000000000001": ["Shell"] }, "/home/me");
    expect(link).toEqual({
      v: 1,
      id: A,
      name: "Desk",
      shares: { "vf-ws-000000000000": { name: "P0", mode: "send", filesOnly: true, hint: "Projects/p0", rev: 3 } },
      stopped: ["vf-ws-eeeeeeeeeeee"],
      live: { "vf-ws-000000000000": ["Claude Code"] },
    });
    expect(homeHint("/srv/site", "/home/me")).toBe("");
    expect(homeHint("/home/me", "/home/me")).toBe("");
  });

  it("is written only when it says something new, and read back with care", () => {
    const dir = temp();
    const file = path.join(dir, `${A}.json`);
    const link: LinkFile = { v: 1, id: A, name: "Desk", shares: { "vf-ws-000000000000": { name: "P0", mode: "two", filesOnly: false, hint: "Projects/p0", rev: 1 } }, stopped: [], live: {} };
    expect(writeLink(file, link)).toBe(true);
    expect(writeLink(file, link)).toBe(false);
    expect(readLink(file, A)).toEqual(link);
    // Written by another machine: its id must be the one expected, and nothing is taken on trust.
    expect(readLink(file, B)).toBeNull();
    expect(readLink(path.join(dir, "missing.json"), A)).toBeNull();
    fs.writeFileSync(
      file,
      JSON.stringify({
        v: 1,
        id: A,
        name: "x".repeat(500),
        shares: {
          "vf-ws-000000000000": { name: "", mode: "receive", filesOnly: 1, hint: "../../etc", rev: -4 },
          "vf-ws-000000000001": { name: "Abs", mode: "two", hint: "/etc/passwd" },
          "not-ours": { name: "X", mode: "two" },
          "vf-ws-000000000002": { name: "No mode" },
        },
        stopped: ["vf-ws-000000000009", 7, "other"],
        live: { "vf-ws-000000000000": ["Claude Code", 5, ""], "vf-ws-00000000000f": ["Ghost"] },
      }),
    );
    const read = readLink(file, A) as LinkFile;
    expect(read.name).toHaveLength(80);
    expect(read.shares).toEqual({
      "vf-ws-000000000000": { name: "Workspace", mode: "receive", filesOnly: false, hint: "", rev: 1 },
      "vf-ws-000000000001": { name: "Abs", mode: "two", filesOnly: false, hint: "", rev: 1 },
    });
    expect(read.stopped).toEqual(["vf-ws-000000000009"]);
    expect(read.live).toEqual({ "vf-ws-000000000000": ["Claude Code"] });
    fs.writeFileSync(file, JSON.stringify({ v: 2, id: A }));
    expect(readLink(file, A)).toBeNull();
  });

  const theirs = (shares: LinkFile["shares"], stopped: string[] = []): LinkFile => ({ v: 1, id: B, name: "Lap", shares, stopped, live: {} });

  it("turns what the other machine shares into an offer, mirrored", () => {
    const settled = settleWithLink(state(), A, B, theirs({ "vf-ws-0123456789ab": { name: "Site", mode: "send", filesOnly: true, hint: "Projects/site", rev: 1 } }));
    expect(settled.changed).toBe(false);
    expect(settled.offers).toEqual([{ folderId: "vf-ws-0123456789ab", name: "Site", mode: "receive", filesOnly: true, hint: "Projects/site" }]);
    // One this machine already said no to isn't offered again.
    const declined = settleWithLink(state([], { stopped: { "vf-ws-0123456789ab": B } }), A, B, theirs({ "vf-ws-0123456789ab": { name: "Site", mode: "two", filesOnly: false, hint: "", rev: 1 } }));
    expect(declined.offers).toEqual([]);
    expect(declined.state.stopped).toEqual({ "vf-ws-0123456789ab": B });
  });

  it("ends a share the other machine ended, and forgets a stop once the other has dropped it", () => {
    const ended = settleWithLink(state([{}, {}]), A, B, theirs({}, ["vf-ws-000000000000"]));
    expect(ended.changed).toBe(true);
    expect(ended.ended.map((share) => share.name)).toEqual(["P0"]);
    expect(ended.state.shares.map((share) => share.name)).toEqual(["P1"]);
    const forgotten = settleWithLink(state([], { stopped: { "vf-ws-0123456789ab": B, "vf-ws-aaaaaaaaaaaa": A } }), A, B, theirs({}));
    expect(forgotten.state.stopped).toEqual({ "vf-ws-aaaaaaaaaaaa": A });
    expect(forgotten.changed).toBe(true);
  });

  it("takes over a newer mode, and settles a tie the same way on both machines", () => {
    const id = "vf-ws-000000000000";
    const newer = settleWithLink(state([{ mode: "two", rev: 1 }]), A, B, theirs({ [id]: { name: "P0", mode: "send", filesOnly: true, hint: "", rev: 2 } }));
    expect(newer.state.shares[0]).toMatchObject({ mode: "receive", filesOnly: true, rev: 2 });
    // Older or the same: nothing changes.
    expect(settleWithLink(state([{ mode: "send", rev: 3 }]), A, B, theirs({ [id]: { name: "P0", mode: "two", filesOnly: false, hint: "", rev: 2 } })).changed).toBe(false);
    expect(settleWithLink(state([{ mode: "send", rev: 2 }]), A, B, theirs({ [id]: { name: "P0", mode: "receive", filesOnly: false, hint: "", rev: 2 } })).changed).toBe(false);
    // Both changed it at once, to different things: the machine with the lower id wins, on both.
    const lower = [A, B].sort()[0];
    const higher = [A, B].sort()[1];
    const onHigher = settleWithLink({ ...state([{ mode: "two", rev: 2 }]), machines: [{ id: lower, name: "Low", addresses: [] }], shares: [{ ...state([{ mode: "two", rev: 2 }]).shares[0], machineId: lower }] }, higher, lower, { v: 1, id: lower, name: "Low", shares: { [id]: { name: "P0", mode: "send", filesOnly: false, hint: "", rev: 2 } }, stopped: [], live: {} });
    expect(onHigher.state.shares[0].mode).toBe("receive");
    const onLower = settleWithLink({ ...state([{ mode: "send", rev: 2 }]), machines: [{ id: higher, name: "High", addresses: [] }], shares: [{ ...state([{ mode: "send", rev: 2 }]).shares[0], machineId: higher }] }, lower, higher, { v: 1, id: higher, name: "High", shares: { [id]: { name: "P0", mode: "two", filesOnly: false, hint: "", rev: 2 } }, stopped: [], live: {} });
    expect(onLower.changed).toBe(false);
    expect(onLower.state.shares[0].mode).toBe("send");
  });

  it("never lets the other machine widen a share here, only narrow it (decision D2)", () => {
    const id = "vf-ws-000000000000";
    // This machine only sends; the other makes it two-way: kept as it was, and reported.
    const toTwo = settleWithLink(state([{ mode: "send", rev: 1 }]), A, B, theirs({ [id]: { name: "P0", mode: "two", filesOnly: false, hint: "", rev: 2 } }));
    expect(toTwo.state.shares[0]).toMatchObject({ mode: "send", rev: 1 });
    expect(toTwo.widened).toEqual([expect.objectContaining({ mode: "two", filesOnly: false, rev: 2 })]);
    // Files only here; the other starts sending .git too: kept.
    const withGit = settleWithLink(state([{ mode: "two", filesOnly: true, rev: 1 }]), A, B, theirs({ [id]: { name: "P0", mode: "two", filesOnly: false, hint: "", rev: 2 } }));
    expect(withGit.state.shares[0]).toMatchObject({ filesOnly: true, rev: 1 });
    expect(withGit.widened).toHaveLength(1);
    // Taking only, here; the other turns it around so this machine would send: kept.
    expect(settleWithLink(state([{ mode: "receive", rev: 1 }]), A, B, theirs({ [id]: { name: "P0", mode: "receive", filesOnly: false, hint: "", rev: 2 } })).widened).toHaveLength(1);
    // Narrowing is taken over as before, with nothing to report.
    const narrower = settleWithLink(state([{ mode: "two", rev: 1 }]), A, B, theirs({ [id]: { name: "P0", mode: "two", filesOnly: true, hint: "", rev: 2 } }));
    expect(narrower.state.shares[0]).toMatchObject({ mode: "two", filesOnly: true, rev: 2 });
    expect(narrower.widened).toEqual([]);
  });
});
