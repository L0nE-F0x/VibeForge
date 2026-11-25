import path from "node:path";
import { JsonFiles } from "./json-files.js";
import type { ReadCache } from "./read-cache.js";
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

/**
 * The chats, kept together in `<data>/chats.json`: each one's agent, engine, folder and runs. A
 * chats.json that can't be read lists the chats it held when it last read correctly, and isn't
 * saved over (JsonFiles).
 */
export class Chats {
  private readonly dataRoot: string;

  constructor(
    dataRoot: string,
    private readonly cache?: ReadCache,
    private readonly files = new JsonFiles(),
  ) {
    this.dataRoot = dataRoot;
  }

  private chatFile(): string {
    return path.join(this.dataRoot, "chats.json");
  }

  listChats(): ChatRecord[] {
    const load = () => {
      const read = this.files.read(this.chatFile());
      const raw = (read.state === "ok" ? read.value : read.saved) ?? null;
      const list = Array.isArray(raw) ? raw : (raw as { chats?: unknown } | null)?.chats;
      if (!Array.isArray(list)) return [];
      return list
        .map(normalizeChat)
        .filter((chat): chat is ChatRecord => chat !== null)
        .sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
    };
    return this.cache ? this.cache.read(this.chatFile(), load) : load();
  }

  getChat(id: string): ChatRecord | null {
    return this.listChats().find((chat) => chat.id === id) ?? null;
  }

  writeChat(chat: ChatRecord): void {
    this.files.beforeWrite(this.chatFile());
    const chats = this.listChats().filter((item) => item.id !== chat.id);
    chats.push(chat);
    this.files.write(this.chatFile(), { chats });
    this.cache?.forget(this.chatFile());
  }

  deleteChat(id: string): void {
    this.files.beforeWrite(this.chatFile());
    this.files.write(this.chatFile(), { chats: this.listChats().filter((chat) => chat.id !== id) });
    this.cache?.forget(this.chatFile());
  }
}
