const readline = require("readline");
const { spawnManagedPty, getPty, listPtys } = require("./host.js");
const { startPromptedSession } = require("./launch.js");
const { markStopRequested, readRun } = require("../core/runfiles.js");
const { finalizeRun } = require("./finalize.js");

const sessions = new Map();

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

function reply(reqId, body) {
  send({ reqId, ...body });
}

async function handle(msg) {
  if (msg.op === "spawn") {
    const managed = spawnManagedPty({
      cwd: msg.cwd,
      argv: msg.argv,
      cols: msg.cols,
      rows: msg.rows,
      runDir: msg.runDir || null,
    });
    const finalized = managed.runDir
      ? new Promise((resolve) => {
          managed.onExit((info) => {
            finalizeRun({ runDir: managed.runDir, exitCode: info.exitCode, signal: info.signal }).then(resolve, resolve);
          });
        })
      : null;
    sessions.set(managed.id, { pty: managed, finalized, runDir: managed.runDir });
    wire(managed, finalized, managed.runDir);
    reply(msg.reqId, { ok: true, ptyId: managed.id, pid: managed.pid });
    return;
  }

  if (msg.op === "startPrompted") {
    const session = await startPromptedSession({
      dataRoot: msg.dataRoot,
      cwd: msg.cwd,
      argv: msg.argv,
      preamble: msg.preamble,
      origin: msg.origin,
      slug: msg.slug,
      cols: msg.cols,
      rows: msg.rows,
      meta: msg.meta || {},
    });
    sessions.set(session.ptyId, { pty: session.pty, finalized: session.finalized, runDir: session.runDir });
    wire(session.pty, session.finalized, session.runDir);
    reply(msg.reqId, {
      ok: true,
      ptyId: session.ptyId,
      pid: session.pid,
      runId: session.runId,
      runDir: session.runDir,
    });
    return;
  }

  if (msg.op === "write") {
    const found = getPty(msg.ptyId);
    if (!found) throw new Error("That session has ended.");
    found.write(msg.data);
    reply(msg.reqId, { ok: true });
    return;
  }

  if (msg.op === "resize") {
    const found = getPty(msg.ptyId);
    if (found) found.resize(msg.cols, msg.rows);
    reply(msg.reqId, { ok: true });
    return;
  }

  if (msg.op === "kill") {
    if (msg.runDir) markStopRequested(msg.runDir);
    const found = getPty(msg.ptyId);
    if (found) found.kill();
    reply(msg.reqId, { ok: true });
    return;
  }

  if (msg.op === "snapshot") {
    const found = getPty(msg.ptyId);
    if (!found) {
      reply(msg.reqId, { ok: true, text: "", seq: 0, alive: false });
      return;
    }
    const snap = found.snapshot();
    reply(msg.reqId, { ok: true, text: snap.text, seq: snap.seq, alive: true });
    return;
  }

  if (msg.op === "list") {
    reply(msg.reqId, { ok: true, ptys: listPtys() });
    return;
  }

  throw new Error(`Unknown op ${msg.op}`);
}

function wire(managed, finalized, runDir) {
  managed.onData((data, seq) => {
    send({ event: "data", ptyId: managed.id, data, seq });
  });
  managed.onExit(async (info) => {
    if (finalized) {
      try {
        await finalized;
      } catch {
        /* finalize errors stay in the run dir */
      }
    }
    const meta = runDir ? readRun(runDir) : null;
    send({
      event: "exit",
      ptyId: managed.id,
      exitCode: info.exitCode,
      runDir: runDir || managed.runDir || null,
      status: meta?.status || "exited",
    });
  });
}

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  Promise.resolve(handle(msg)).catch((error) => {
    if (msg && msg.reqId) {
      reply(msg.reqId, { ok: false, error: error instanceof Error ? error.message : String(error) });
    } else {
      send({ event: "error", error: error instanceof Error ? error.message : String(error) });
    }
  });
});

process.stdin.on("end", () => {
  for (const item of sessions.values()) item.pty.kill();
  setTimeout(() => process.exit(0), 300).unref?.();
});

send({ event: "ready" });
