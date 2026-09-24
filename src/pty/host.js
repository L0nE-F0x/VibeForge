const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const pty = require("node-pty");

const MAX_SCROLL = 2 * 1024 * 1024;
const registry = new Map();

function spawnManagedPty(opts) {
  const id = crypto.randomUUID();
  const cwd = opts.cwd;
  const argv = opts.argv && opts.argv.length ? opts.argv : [process.env.SHELL || "/bin/bash"];
  const file = argv[0];
  const args = argv.slice(1);
  const term = pty.spawn(file, args, {
    name: "xterm-256color",
    cols: opts.cols || 80,
    rows: opts.rows || 24,
    cwd,
    env: { ...process.env, TERM: "xterm-256color", ...(opts.env || {}) },
  });

  let buf = "";
  let seq = 0;
  const dataHandlers = [];
  const exitHandlers = [];
  const runDir = opts.runDir || null;
  const scrollFile = runDir ? path.join(runDir, "scrollback.txt") : null;
  let killTimer = null;
  let exited = false;

  term.onData((data) => {
    seq += 1;
    buf += data;
    if (buf.length > MAX_SCROLL) {
      buf = buf.slice(buf.length - MAX_SCROLL);
      if (scrollFile) fs.writeFileSync(scrollFile, buf);
    } else if (scrollFile) {
      fs.appendFileSync(scrollFile, data);
    }
    for (const cb of dataHandlers) cb(data, seq);
  });

  term.onExit(({ exitCode, signal }) => {
    exited = true;
    if (killTimer) clearTimeout(killTimer);
    const info = { exitCode: exitCode ?? null, signal: signal ?? null };
    for (const cb of exitHandlers) cb(info);
    registry.delete(id);
  });

  function signalGroup(pid, sig) {
    if (!pid || pid <= 0) return;
    try {
      process.kill(-pid, sig);
    } catch {
      try {
        process.kill(pid, sig);
      } catch {
        /* already gone */
      }
    }
  }

  const managed = {
    id,
    pid: term.pid,
    cwd,
    runDir,
    get exited() {
      return exited;
    },
    write(data) {
      if (!exited) term.write(data);
    },
    resize(cols, rows) {
      if (exited) return;
      try {
        term.resize(Math.max(2, cols | 0), Math.max(2, rows | 0));
      } catch {
        /* pty already closed */
      }
    },
    kill() {
      if (exited) return;
      const pid = term.pid;
      signalGroup(pid, "SIGINT");
      killTimer = setTimeout(() => signalGroup(pid, "SIGKILL"), 2000);
      if (typeof killTimer.unref === "function") killTimer.unref();
    },
    onData(cb) {
      dataHandlers.push(cb);
    },
    onExit(cb) {
      exitHandlers.push(cb);
    },
    snapshot() {
      return { text: buf, seq };
    },
  };

  registry.set(id, managed);
  return managed;
}

function getPty(id) {
  return registry.get(id) || null;
}

function listPtys() {
  return [...registry.values()].map((p) => ({
    ptyId: p.id,
    pid: p.pid,
    cwd: p.cwd,
    runDir: p.runDir,
  }));
}

module.exports = { spawnManagedPty, getPty, listPtys, MAX_SCROLL };
