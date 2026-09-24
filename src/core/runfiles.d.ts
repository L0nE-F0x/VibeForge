export interface RunMetaFile {
  id: string;
  origin: string;
  agentId: string | null;
  routineId: string | null;
  taskId: string | null;
  chatId: string | null;
  engine: string | null;
  cwd: string;
  prompt: string;
  startedAt: string;
  endedAt: string | null;
  status: "running" | "exited" | "stopped" | "failed";
  openedAt: string | null;
  notifiedAt: string | null;
  ptyId: string | null;
  stopRequested: boolean;
  exitCode: number | null;
  dir: string;
  error?: string;
  signal?: number | null;
}

export function runFolderStamp(date: Date): string;
export function createRunFiles(opts: {
  dataRoot: string;
  slug: string;
  preamble: string;
  now?: Date;
  meta: {
    origin: string;
    cwd: string;
    prompt?: string;
    agentId?: string | null;
    routineId?: string | null;
    taskId?: string | null;
    chatId?: string | null;
    engine?: string | null;
    startedAt?: string;
    ptyId?: string | null;
  };
}): { id: string; dir: string; meta: RunMetaFile };
export function readRun(dir: string): RunMetaFile | null;
export function writeMeta(dir: string, meta: RunMetaFile): void;
export function markStopRequested(dir: string): RunMetaFile | null;
export function listRunDirs(dataRoot: string): string[];
