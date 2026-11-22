# Workspace sync: how it is built

Shipped in 2.19.0 (2026-11-17). What it does for a person is in the [README](../README.md#sync); this is the design, and what the spike behind it found.

## Shape

- **The engine is Syncthing**, one pinned release (`scripts/syncthing.json`), unmodified, carried in `vendor/syncthing/` by the ready-made build (`scripts/pack-release.mjs`) and fetched once by a checkout or a source build (`scripts/fetch-syncthing.mjs`, checked against the pinned SHA-256). A Syncthing on `PATH` is never used. `--bump vX.Y.Z` moves the pin from the release's signed checksum list.
- **It runs privately** (`electron/sync-engine.ts`): its own home under `<data>/sync/engine`, started when Settings turn sync on and stopped when they turn it off or VibeForge quits. `config.xml` is rewritten before every start (`lockDown` in `src/core/sync/protocol.ts`): no global discovery, relays, NAT traversal, usage or crash reports, upgrades or browser. It listens on TCP 22737 and announces on the local network on UDP 21737, both apart from Syncthing's own ports. Its REST interface is on loopback, on a port and with a key made fresh each start.
- **What a person decided is VibeForge's** (`src/core/sync/desk.ts`, `<data>/sync/state.json`): paired machines, shares (workspace folder, machine, direction, files only) and stops. The desk makes Syncthing match it, and removes only folders it made (`vf-ws-…`, `vf-link-…`).
- **Two paired machines keep one small private folder between them** (`src/core/sync/link.ts`). Each writes one file there: what it shares with the other, what it stopped, what runs in each shared workspace now. That is how an offer arrives (Syncthing's own folder offer carries only an id and a label), how a direction change or a stop is followed, and how "in use on the other machine" is known. No extra port or protocol.
- **Conflict copies never stay in a workspace** (`src/core/sync/conflicts.ts`). `*.sync-conflict-*` is ignored, so a copy exists only on the machine that lost; the desk looks where files just arrived (Syncthing has no conflict event), moves each copy into `<data>/sync/conflicts/` and lists it for Compare / Keep theirs / Put mine back. Answered ones are kept 30 days.
- **`.git` is synced by default**, without `.git/worktrees` (a task copy's absolute paths), `.git/hooks`, `.git/config`, lock files and `gc.pid`. `prepareRepo` sets `core.trustctime=false` and `core.checkStat=minimal`, without which every `git status` rewrites `.git/index` per machine and the two send it back and forth. When both machines committed while apart, `rescueRepo` (`src/core/sync/git-rescue.ts`) keeps this machine's commits on `<branch>-from-<machine>`, rebuilds the index when both had changed it, puts files that are byte for byte a kept commit's back to the branch's version, and removes the copies. It never removes a pointer it could not save, and never a version of a file that isn't in a commit.

## Agents and skills (3.2.0)

- **Opt-in, per item** (`src/core/sync/library.ts`). A person turns syncing on for an agent or a skill. A synced agent's skills sync because it carries them, even though they aren't turned on themselves. Each synced item gets a sync id (`vf-ag-…`, `vf-sk-…`) the same on every machine. What this machine knows about it lives in `<data>/sync/library/<sync id>.json`: its local id, each part's change counts, and the last version both machines agreed on. `agent.yaml` and `SKILL.md` keep their format.
- **Carried in the link folder, one writer per file.** Each machine writes `<link>/library/<its device id>/<sync id>.json` into the folder it keeps with each paired machine, and reads only the other machine's subfolder, so Syncthing never sees two machines change one file. Agents and skills go to every paired machine. What arrives is checked part by part: no absolute paths, no dot-folders, ids and sizes capped (256 KB of text).
- **Merged part by part** (`library-merge.ts`). Each part counts its changes per machine: name, brief, memory, good at, tier, routines, CLI, skills and folders for an agent; name, description and text for a skill. A part both machines changed since they last agreed is merged. Texts go line by line against the last agreed version (diff3): where both only added lines at one spot, both additions stay. Where both changed the same lines, memory keeps both and a brief or skill text keeps the later change. The machine whose text lost keeps it as a conflict (`kind: "agent" | "skill"` in the conflict store), whether it did the merge itself or heard about it through a note in the other machine's file. Sets (skills, folders) keep what either added. Single values go to the later change. The merge gives the same answer on both machines, and once they're in step they stop writing.
- **Folders travel as workspaces** (`places-match.ts`). A folder goes as `{synced folder id, workspace name, folder inside it, place under home}`. The receiving machine looks for the synced workspace, then exactly one workspace of that name, then the same place under home. One that isn't found waits: it stays in the agent's set (so it isn't taken for a removal), shows on the Folders tab, and is taken as soon as a matching workspace appears. A folder outside every workspace and outside home stays on its own machine.
- **The CLI travels as id, name and command.** The receiving machine uses that CLI if it's installed, else one with the same command, else its default, else the first installed one. It keeps sending the one asked for, so a stand-in never changes the other machine's choice, and it switches back once the agent's own CLI is installed. An incoming file can only pick one of the CLIs already set up on the machine.
- **On and off, and deletes.** Off on either machine is off on both, and both keep their copy. A delete is told once its Undo has run out (35 s). On the other machine it moves the item to the trash, unless that machine changed the item since, in which case the item stays and comes back on the machine that deleted it.
- **Not built:** syncing an agent's chats, runs or routines; choosing which paired machines an agent goes to.

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
