import path from "node:path";
import { readJson, writeJson } from "../fsx.js";
import { isSafeId } from "../slug.js";
import type { ChatRecord } from "../types.js";
import { str, strList, strOrNull } from "./fields.js";

function normalizeChat(value: unknown): ChatRecord | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const id = str(record.id);
  if (!isSafeId(id)) return null;
  const runIds = strList(record.runIds);
  const legacy = strOrNull(record.runId);
  if (legacy && !runIds.includes(legacy)) runIds.push(legacy);
  return {
    id,
    title: str(record.title) || "Chat",
    agentId: strOrNull(record.agentId),
    engine: str(record.engine),
    cwd: str(record.cwd),
    runIds,
    createdAt: str(record.createdAt),
    updatedAt: str(record.updatedAt),
  };
}

/** The chats, kept together in `<data>/chats.json`: each one's agent, engine, folder and runs. */
export class Chats {
  private readonly dataRoot: string;

  constructor(dataRoot: string) {
    this.dataRoot = dataRoot;
  }

  private chatFile(): string {
    return path.join(this.dataRoot, "chats.json");
  }

  listChats(): ChatRecord[] {
    const raw = readJson<unknown>(this.chatFile(), null);
    const list = Array.isArray(raw) ? raw : (raw as { chats?: unknown } | null)?.chats;
    if (!Array.isArray(list)) return [];
    return list
      .map(normalizeChat)
      .filter((chat): chat is ChatRecord => chat !== null)
      .sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
  }

  getChat(id: string): ChatRecord | null {
    return this.listChats().find((chat) => chat.id === id) ?? null;
  }

  writeChat(chat: ChatRecord): void {
    const chats = this.listChats().filter((item) => item.id !== chat.id);
    chats.push(chat);
    writeJson(this.chatFile(), { chats });
  }

  deleteChat(id: string): void {
    writeJson(this.chatFile(), { chats: this.listChats().filter((chat) => chat.id !== id) });
  }
}
