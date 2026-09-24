import type { ManagedPty } from "./host.js";

export interface PromptedSession {
  runId: string;
  runDir: string;
  ptyId: string;
  pid: number;
  pty: ManagedPty;
  finalized: Promise<unknown>;
  requestStop(): unknown;
}

export function startPromptedSession(opts: {
  dataRoot: string;
  cwd: string;
  argv: string[];
  preamble: string;
  origin: string;
  slug: string;
  cols?: number;
  rows?: number;
  now?: Date;
  meta?: {
    prompt?: string;
    agentId?: string | null;
    routineId?: string | null;
    taskId?: string | null;
    chatId?: string | null;
    engine?: string | null;
    startedAt?: string;
  };
}): Promise<PromptedSession>;
