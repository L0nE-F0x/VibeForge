# ForgeDesk

Personal Linux desk for the coding CLIs already on this machine. No accounts and no telemetry.

Node comes from the mise install already on this Arch machine. Do not install a second Node. `python3`, `make`, and `g++` build the `node-pty` native module against that Node.

## Run

```bash
cd /home/lonefox/Projects/forgedesk
npm install
npm start
```

`npm start` runs Vite and opens the Electron window.

## PTY sidecar

`node-pty` is compiled for mise's Node, so the Electron main process does not load it and does not run `electron-rebuild`. Electron spawns `node` from `PATH` on `src/pty/server.ts`. That sidecar owns every terminal.

Config defaults to `~/.config/forgedesk`. Run artifacts default to `~/.local/share/forgedesk`. Override with `FORGEDESK_CONFIG` and `FORGEDESK_DATA`.

## Test

```bash
npm test
```

The PTY tests use `/bin/bash` only. They do not launch a model CLI.
