# Status

ForgeDesk runs with `npm start` from this directory. The window title is ForgeDesk. Agent, Code, and Chat are the three modes.

Verified on this machine:

- Unit tests cover routine ticks, task execution, preambles, places, engines, and git snapshots.
- PTY tests launch real shells through `src/pty/launch.js` and `src/pty/server.js`, including a stop that keeps the transcript.
- The desktop window opened, created `~/.config/forgedesk` and `~/.local/share/forgedesk`, and the three modes rendered.

Terminals are hosted by a Node sidecar so `node-pty` matches the system Node. Model CLIs are detected on PATH and are not started by the tests.
