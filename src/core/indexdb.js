const fs = require("fs");
const path = require("path");

function openRunIndex(dataRoot) {
  let DatabaseSync;
  try {
    DatabaseSync = require("node:sqlite").DatabaseSync;
  } catch {
    return null;
  }
  fs.mkdirSync(dataRoot, { recursive: true });
  const db = new DatabaseSync(path.join(dataRoot, "index.sqlite"));
  db.exec(`
    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY,
      origin TEXT,
      agentId TEXT,
      routineId TEXT,
      taskId TEXT,
      chatId TEXT,
      engine TEXT,
      cwd TEXT,
      prompt TEXT,
      startedAt TEXT,
      endedAt TEXT,
      status TEXT,
      openedAt TEXT,
      dir TEXT,
      notifiedAt TEXT,
      ptyId TEXT
    )
  `);
  return db;
}

function mirrorRun(db, meta) {
  if (!db || !meta) return;
  db.prepare(
    `INSERT INTO runs (
      id, origin, agentId, routineId, taskId, chatId, engine, cwd, prompt,
      startedAt, endedAt, status, openedAt, dir, notifiedAt, ptyId
    ) VALUES (
      @id, @origin, @agentId, @routineId, @taskId, @chatId, @engine, @cwd, @prompt,
      @startedAt, @endedAt, @status, @openedAt, @dir, @notifiedAt, @ptyId
    )
    ON CONFLICT(id) DO UPDATE SET
      origin = excluded.origin,
      agentId = excluded.agentId,
      routineId = excluded.routineId,
      taskId = excluded.taskId,
      chatId = excluded.chatId,
      engine = excluded.engine,
      cwd = excluded.cwd,
      prompt = excluded.prompt,
      startedAt = excluded.startedAt,
      endedAt = excluded.endedAt,
      status = excluded.status,
      openedAt = excluded.openedAt,
      dir = excluded.dir,
      notifiedAt = excluded.notifiedAt,
      ptyId = excluded.ptyId`,
  ).run({
    id: meta.id,
    origin: meta.origin ?? null,
    agentId: meta.agentId ?? null,
    routineId: meta.routineId ?? null,
    taskId: meta.taskId ?? null,
    chatId: meta.chatId ?? null,
    engine: meta.engine ?? null,
    cwd: meta.cwd ?? null,
    prompt: meta.prompt ?? "",
    startedAt: meta.startedAt ?? null,
    endedAt: meta.endedAt ?? null,
    status: meta.status ?? null,
    openedAt: meta.openedAt ?? null,
    dir: meta.dir ?? null,
    notifiedAt: meta.notifiedAt ?? null,
    ptyId: meta.ptyId ?? null,
  });
}

module.exports = { openRunIndex, mirrorRun };
