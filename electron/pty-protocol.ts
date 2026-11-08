// The JSON lines between the window (electron/supervisor.ts) and the terminal host
// (electron/pty-host.cjs, which reads these types through JSDoc), one object per line. Types
// only: the host runs on the system Node without a build, so nothing here may exist at run time.

/** What the window asks the host, without the reqId the request adds. */
export type PtyAsk =
  | { op: "spawn"; cwd: string; argv: string[]; runDir: string | null; pasteInput: string | null; cols?: number; rows?: number }
  | { op: "write"; ptyId: string; data: string }
  /** Paste text the way a person would, then press Enter unless `enter` is false. */
  | { op: "send"; ptyId: string; text: string; enter: boolean }
  | { op: "resize"; ptyId: string; cols: number; rows: number }
  | { op: "kill"; ptyId: string }
  /** Start recording a shell into a run folder, or (null) stop and write its files. */
  | { op: "record"; ptyId: string; runDir: string | null }
  | { op: "snapshot"; ptyId: string }
  | { op: "list" }
  | { op: "foreground"; ptyId: string }
  | { op: "shutdown" };

export type PtyOp = PtyAsk["op"];

/** A request as it goes down the line; its answer repeats the reqId. */
export type PtyRequest = PtyAsk & { reqId: string };

export interface PtySnapshot {
  ansi: string;
  plain: string;
  seq: number;
  cols: number;
  rows: number;
  alive: boolean;
}

/** What holds a terminal's foreground; argv is null when it is the process VibeForge started. */
export interface PtyForeground {
  argv: string[] | null;
  /** Where that program runs, which can differ from where the shell started. */
  cwd: string | null;
}

type Done = Record<never, never>;

/** What each request answers with when it worked, besides `ok: true`. */
export interface PtyAnswers {
  spawn: { ptyId: string; pid: number };
  write: Done;
  send: Done;
  resize: Done;
  kill: Done;
  record: Done;
  /** A terminal that has ended answers with an empty screen, `alive: false` and no `plain`. */
  snapshot: Omit<PtySnapshot, "plain"> & { plain?: string };
  list: { ptys: Array<{ ptyId: string; pid: number; cwd: string; argv: string[] }> };
  /** `known: false` means the read failed, not that the shell is back. */
  foreground: PtyForeground & { known: boolean };
  shutdown: Done;
}

export type PtyFailure = { ok: false; error: string };

/** The answer to one request, or the reason it failed. */
export type PtyAnswer<Op extends PtyOp = PtyOp> = ({ ok: true } & PtyAnswers[Op]) | PtyFailure;

export type PtyReply<Op extends PtyOp = PtyOp> = PtyAnswer<Op> & { reqId: string };

export interface PtyData {
  ptyId: string;
  data: string;
  /** The seq of the first chunk in `data`; chunks are numbered from 1 in each terminal. */
  first: number;
  seq: number;
}

export interface PtyExit {
  ptyId: string;
  exitCode: number | null;
  signal: number | null;
}

/** The foreground program changed. */
export interface PtyProgram extends PtyForeground {
  ptyId: string;
}

/** A terminal's output started flowing steadily (working) or stopped (quiet). */
export interface PtyActivity {
  ptyId: string;
  working: boolean;
}

/** What the host says on its own. "ready" comes first, once. */
export type PtyEvent =
  | { event: "ready"; pid: number }
  | ({ event: "data" } & PtyData)
  | ({ event: "exit" } & PtyExit)
  | ({ event: "program" } & PtyProgram)
  | ({ event: "activity" } & PtyActivity);

/** Any line the host writes. */
export type PtyLine = PtyEvent | PtyReply;
