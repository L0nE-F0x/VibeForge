export interface ManagedPty {
  id: string;
  pid: number;
  cwd: string;
  runDir: string | null;
  exited: boolean;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
  onData(cb: (data: string, seq: number) => void): void;
  onExit(cb: (info: { exitCode: number | null; signal: number | null }) => void): void;
  snapshot(): { text: string; seq: number };
}

export function spawnManagedPty(opts: {
  cwd: string;
  argv?: string[];
  cols?: number;
  rows?: number;
  env?: NodeJS.ProcessEnv;
  runDir?: string | null;
}): ManagedPty;

export function getPty(id: string): ManagedPty | null;
export function listPtys(): { ptyId: string; pid: number; cwd: string; runDir: string | null }[];
export const MAX_SCROLL: number;
