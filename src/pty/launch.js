const { createRunFiles, writeMeta, markStopRequested } = require("../core/runfiles.js");
const { spawnManagedPty } = require("./host.js");
const { finalizeRun, markFailed } = require("./finalize.js");

async function startPromptedSession(opts) {
  const created = createRunFiles({
    dataRoot: opts.dataRoot,
    slug: opts.slug,
    preamble: opts.preamble,
    now: opts.now,
    meta: {
      origin: opts.origin,
      cwd: opts.cwd,
      prompt: opts.meta?.prompt ?? "",
      agentId: opts.meta?.agentId ?? null,
      routineId: opts.meta?.routineId ?? null,
      taskId: opts.meta?.taskId ?? null,
      chatId: opts.meta?.chatId ?? null,
      engine: opts.meta?.engine ?? null,
      startedAt: opts.meta?.startedAt,
    },
  });

  let managed;
  try {
    managed = spawnManagedPty({
      cwd: opts.cwd,
      argv: opts.argv,
      cols: opts.cols,
      rows: opts.rows,
      runDir: created.dir,
    });
  } catch (error) {
    markFailed(created.dir, error);
    throw error;
  }

  created.meta.ptyId = managed.id;
  writeMeta(created.dir, created.meta);

  let finalized;
  const finalizedPromise = new Promise((resolve) => {
    managed.onExit((info) => {
      finalized = finalizeRun({
        runDir: created.dir,
        exitCode: info.exitCode,
        signal: info.signal,
      }).then(resolve, resolve);
    });
  });

  let input = opts.preamble ?? "";
  if (input && !input.endsWith("\n")) input += "\n";
  if (input) managed.write(input);

  return {
    runId: created.id,
    runDir: created.dir,
    ptyId: managed.id,
    pid: managed.pid,
    pty: managed,
    finalized: finalizedPromise,
    requestStop() {
      return markStopRequested(created.dir);
    },
  };
}

module.exports = { startPromptedSession };
