# Workspace sync: how it is built

Shipped in 2.19.0 (2026-11-17). What it does for a person is in the [README](../README.md#sync); this is the design, and what the spike behind it found.

## Shape

- **The engine is Syncthing**, one pinned release (`scripts/syncthing.json`), unmodified, carried in `vendor/syncthing/` by the ready-made build (`scripts/pack-release.mjs`) and fetched once by a checkout or a source build (`scripts/fetch-syncthing.mjs`, checked against the pinned SHA-256). A Syncthing on `PATH` is never used. `--bump vX.Y.Z` moves the pin from the release's signed checksum list.
- **It runs privately** (`electron/sync-engine.ts`): its own home under `<data>/sync/engine`, started when Settings turn sync on and stopped when they turn it off or VibeForge quits. `config.xml` is rewritten before every start (`lockDown` in `src/core/sync/protocol.ts`): no global discovery, relays, NAT traversal, usage or crash reports, upgrades or browser. It listens on TCP 22737 and announces on the local network on UDP 21737, both apart from Syncthing's own ports. Its REST interface is on loopback, on a port and with a key made fresh each start.
- **What a person decided is VibeForge's** (`src/core/sync/desk.ts`, `<data>/sync/state.json`): paired machines, shares (workspace folder, machine, direction, files only) and stops. The desk makes Syncthing match it, and removes only folders it made (`vf-ws-…`, `vf-link-…`).
- **Two paired machines keep one small private folder between them** (`src/core/sync/link.ts`). Each writes one file there: what it shares with the other, what it stopped, what runs in each shared workspace now. That is how an offer arrives (Syncthing's own folder offer carries only an id and a label), how a direction change or a stop is followed, and how "in use on the other machine" is known. No extra port or protocol.
- **Conflict copies never stay in a workspace** (`src/core/sync/conflicts.ts`). `*.sync-conflict-*` is ignored, so a copy exists only on the machine that lost; the desk looks where files just arrived (Syncthing has no conflict event), moves each copy into `<data>/sync/conflicts/` and lists it for Compare / Keep theirs / Put mine back. Answered ones are kept 30 days.
- **`.git` is synced by default**, without `.git/worktrees` (a task copy's absolute paths), lock files and `gc.pid`. `prepareRepo` sets `core.trustctime=false` and `core.checkStat=minimal`, without which every `git status` rewrites `.git/index` per machine and the two send it back and forth. When both machines committed while apart, `rescueRepo` (`src/core/sync/git-rescue.ts`) keeps this machine's commits on `<branch>-from-<machine>`, rebuilds the index when both had changed it, puts files that are byte for byte a kept commit's back to the branch's version, and removes the copies. It never removes a pointer it could not save, and never a version of a file that isn't in a commit.

## What the spike found (Syncthing 2.1.7, two instances on loopback)

- Locked down, an instance contacted nothing in a network-less sandbox; with defaults it tried discovery, relays, upgrades and STUN.
- A conflict copy's suffix names the machine whose version *won*; the copy holds the other's. The later change wins; a later delete wins over an edit, and the edit is kept as the copy.
- `maxConflicts=0` discards the losing version silently. Never used.
- A receive-only side that is edited locally still gets conflict copies.
- Git reads a conflict copy of `refs/heads/main` as a branch of that name, which is why keeping it under a better name is all the rescue has to do.
- Each instance is two processes (a monitor and the worker), about 90 MB together; the binary is 34 MB, 11.8 MB in the release archive.

## Not built

- More than one other machine per workspace.
- Telling the other machine about a conflict waiting here.
- A way through two firewalls with neither opened (that would need a relay, which the private instance has off on purpose).
