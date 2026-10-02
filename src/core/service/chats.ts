import fs from "node:fs";
import path from "node:path";
import { isDirectory } from "../fsx.js";
import { cwdAllowed, isPathInside } from "../places.js";
import { plainPrompt } from "../preamble.js";
import { RUN_FILES } from "../runs.js";
import { runFilePaths } from "../run-storage.js";
import { slugify } from "../slug.js";
import type { ChatRecord } from "../types.js";
import { type ChatView, DEFAULT_CHAT_TITLE, type Deleted, type Launched, type SendResult, type TermSize, titleFromPrompt } from "./types.js";
import type { ServiceCore } from "./core.js";

/** Chats, plain or with an agent: each message pastes into a live session or picks the last one up again. */
export class ChatDesk {
  constructor(private readonly core: ServiceCore) {}

  listChats(filter: { agentId?: string | null } = {}): ChatView[] {
    return this.core.store
      .listChats()
      .filter((chat) => (filter.agentId === undefined ? true : chat.agentId === filter.agentId))
      .map((chat) => this.chatView(chat));
  }

  private chatView(chat: ChatRecord): ChatView {
    const lastId = chat.runIds[chat.runIds.length - 1];
    const last = lastId ? this.core.store.getRun(lastId) : null;
    const ptyId = lastId ? (this.core.ptyByRun.get(lastId) ?? null) : null;
    return { ...chat, live: Boolean(ptyId), ptyId, lastRun: last ? this.core.view(last) : null };
  }

  createChat(input: { agentId?: string | null; engine?: string }): ChatView {
    const now = this.core.now().toISOString();
    if (input.agentId) {
      const agent = this.core.store.getAgent(input.agentId);
      if (!agent) throw new Error("That agent no longer exists.");
      const cwd = this.core.firstPlace(agent.places);
      if (!cwd) throw new Error(`None of ${agent.name}'s allowed folders exist any more.`);
      const chat: ChatRecord = {
        id: this.uniqueChatId(`${agent.id}-chat`),
        title: DEFAULT_CHAT_TITLE,
        agentId: agent.id,
        engine: agent.engine,
        cwd,
        runIds: [],
        createdAt: now,
        updatedAt: now,
      };
      this.core.store.writeChat(chat);
      this.core.emit("chats");
      return this.chatView(chat);
    }
    const engineId = input.engine?.trim() || this.core.store.readSettings().defaultEngine;
    this.core.requireEngine(engineId);
    const id = this.uniqueChatId("chat");
    const chat: ChatRecord = {
      id,
      title: DEFAULT_CHAT_TITLE,
      agentId: null,
      engine: engineId,
      cwd: path.join(this.core.options.dataRoot, "scratch", id),
      runIds: [],
      createdAt: now,
      updatedAt: now,
    };
    this.core.store.writeChat(chat);
    this.core.emit("chats");
    return this.chatView(chat);
  }

  renameChat(id: string, title: string): ChatView {
    const chat = this.core.store.getChat(id);
    if (!chat) throw new Error("That chat no longer exists.");
    const next = { ...chat, title: title.trim() || chat.title, updatedAt: this.core.now().toISOString() };
    this.core.store.writeChat(next);
    this.core.emit("chats");
    return this.chatView(next);
  }

  setChatEngine(id: string, engineId: string): ChatView {
    const chat = this.core.store.getChat(id);
    if (!chat) throw new Error("That chat no longer exists.");
    if (chat.agentId) throw new Error("An agent chat uses the agent's engine.");
    this.core.requireEngine(engineId);
    const next = { ...chat, engine: engineId, updatedAt: this.core.now().toISOString() };
    this.core.store.writeChat(next);
    this.core.emit("chats");
    return this.chatView(next);
  }

  async deleteChat(id: string): Promise<Deleted> {
    const chat = this.core.store.getChat(id);
    if (!chat) throw new Error("That chat no longer exists.");
    for (const runId of chat.runIds) {
      const ptyId = this.core.ptyByRun.get(runId);
      if (!ptyId) continue;
      const exited = this.core.waitForExit(ptyId, 6000);
      await this.core.stopRun(runId);
      await exited;
    }
    // Its scratch folder and what its runs said go with it; the runs themselves stay in Runs.
    const paths: string[] = [];
    const scratchRoot = path.join(this.core.options.dataRoot, "scratch");
    if (!chat.agentId && chat.cwd && isPathInside(scratchRoot, chat.cwd) && path.resolve(chat.cwd) !== path.resolve(scratchRoot)) {
      paths.push(chat.cwd);
    }
    for (const runId of chat.runIds) {
      const run = this.core.store.getRun(runId);
      if (!run?.dir) continue;
      for (const name of ["scrollback", "screen", "transcript"] as const) paths.push(...runFilePaths(run.dir, RUN_FILES[name]));
    }
    const record = this.core.store.getChat(id) ?? chat;
    const bin = this.core.trash.stash(paths);
    this.core.store.deleteChat(id);
    this.core.emit("chats", "runs");
    return this.core.keepForUndo(bin, () => {
      this.core.store.writeChat(record);
      this.core.emit("chats", "runs");
    });
  }

  /**
   * Send text to a chat. A live session gets it pasted in; an empty chat starts the engine with it;
   * an ended chat continues the engine's session and pastes the text once it is ready.
   */
  async sendChat(id: string, text: string, size: TermSize = {}): Promise<SendResult> {
    if (!text.trim()) throw new Error("Type something to send.");
    await this.core.settled;
    let chat = this.core.store.getChat(id);
    if (!chat) throw new Error("That chat no longer exists.");
    if (chat.title === DEFAULT_CHAT_TITLE) {
      chat = { ...chat, title: titleFromPrompt(text) };
      this.core.store.writeChat(chat);
    }
    const lastId = chat.runIds[chat.runIds.length - 1];
    const livePty = lastId ? this.core.ptyByRun.get(lastId) : undefined;
    if (lastId && livePty) {
      await this.core.options.host.send(livePty, text);
      this.core.store.writeChat({ ...chat, updatedAt: this.core.now().toISOString() });
      this.core.emit("chats");
      return { chatId: chat.id, runId: lastId, ptyId: livePty, started: false, note: null };
    }
    if (!lastId) {
      const launched = await this.startChatRun(chat, { prompt: text, continueSession: false, size });
      return { ...launched, chatId: chat.id, started: true, note: null };
    }
    const launched = await this.startChatRun(chat, { prompt: text, continueSession: true, size });
    return { ...launched, chatId: chat.id, started: true, note: "The last session had ended, so VibeForge picked it up again." };
  }

  /** Reopen the engine's latest session for this chat, with no new prompt. */
  async continueChat(id: string, size: TermSize = {}): Promise<SendResult> {
    // Runs left over from a crash are still being recorded; starting now could race them.
    await this.core.settled;
    const chat = this.core.store.getChat(id);
    if (!chat) throw new Error("That chat no longer exists.");
    const lastId = chat.runIds[chat.runIds.length - 1];
    const livePty = lastId ? this.core.ptyByRun.get(lastId) : undefined;
    if (lastId && livePty) return { chatId: chat.id, runId: lastId, ptyId: livePty, started: false, note: null };
    const launched = await this.startChatRun(chat, { prompt: null, continueSession: Boolean(lastId), size });
    return { ...launched, chatId: chat.id, started: true, note: null };
  }

  /**
   * Start this agent in a workspace, with its brief, or type `prompt` into the session it already
   * has there. The workspace folder has to be one of the agent's allowed folders.
   */
  async launchAgent(workspaceId: string, agentId: string, prompt: string | null, size: TermSize = {}): Promise<SendResult> {
    await this.core.settled;
    const workspace = this.core.workspaceById(workspaceId);
    if (!workspace) throw new Error("That workspace is gone.");
    if (!isDirectory(workspace.path)) throw new Error(`The workspace folder is gone: ${workspace.path}`);
    const agent = this.core.store.getAgent(agentId);
    if (!agent) throw new Error("That agent no longer exists.");
    if (!cwdAllowed(workspace.path, agent.places)) throw new Error(`${agent.name} is not allowed in ${workspace.name}.`);
    const cwd = path.resolve(workspace.path);
    const already = this.core.listLive().find((session) => {
      if (session.agentId !== agent.id) return false;
      return session.workspaceId === workspace.id || path.resolve(session.cwd) === cwd;
    });
    if (already) throw new Error(`${agent.name} is already running in ${workspace.name}.`);
    let chat = this.core.store.listChats().find((item) => item.agentId === agent.id && path.resolve(item.cwd) === cwd) ?? null;
    if (!chat) {
      const created = this.createChat({ agentId });
      const stored = this.core.store.getChat(created.id);
      if (!stored) throw new Error("The chat was not saved.");
      chat = path.resolve(stored.cwd) === cwd ? stored : { ...stored, cwd };
      if (chat !== stored) this.core.store.writeChat(chat);
    }
    const text = prompt?.trim() ?? "";
    if (text) return this.sendChat(chat.id, text, size);
    return this.continueChat(chat.id, size);
  }

  async stopChat(id: string): Promise<void> {
    const chat = this.core.store.getChat(id);
    const lastId = chat?.runIds[chat.runIds.length - 1];
    if (lastId) await this.core.stopRun(lastId);
  }

  private async startChatRun(
    chat: ChatRecord,
    opts: { prompt: string | null; continueSession: boolean; size: TermSize },
  ): Promise<Launched> {
    const agent = chat.agentId ? this.core.store.getAgent(chat.agentId) : null;
    if (chat.agentId && !agent) throw new Error("This chat's agent no longer exists.");
    const engine = this.core.requireEngine(agent ? agent.engine : chat.engine);
    const previous = opts.continueSession ? this.core.store.getRun(chat.runIds[chat.runIds.length - 1] ?? "") : null;
    const resume = this.core.resumePlan(engine.row, previous);
    const nativeContinue = resume.native;
    const prior = previous && !nativeContinue ? this.core.transcriptPath(previous) : null;
    let cwd = chat.cwd;
    if (agent) cwd = isDirectory(chat.cwd) && agent.places.some((place) => isPathInside(place, chat.cwd)) ? chat.cwd : (this.core.firstPlace(agent.places) ?? "");
    if (!cwd) throw new Error("The chat's folder is gone.");
    if (!agent) fs.mkdirSync(cwd, { recursive: true });
    let promptText: string | null = null;
    let pasteAfterContinue: string | null = null;
    if (nativeContinue) {
      pasteAfterContinue = opts.prompt;
    } else if (agent) {
      const fallback = previous ? "Continue where the previous attempt stopped." : "Read this, then wait for my first instruction.";
      promptText = this.core.preambleFor(agent, opts.prompt ?? fallback, prior);
    } else if (opts.prompt || prior) {
      promptText = plainPrompt(opts.prompt ?? "Continue where we left off.", prior);
    }
    return this.core.launch({
      origin: agent ? "agent-chat" : "chat",
      title: agent ? `${agent.name} · ${chat.title}` : chat.title,
      engine,
      cwd,
      prompt: opts.prompt ?? "",
      promptText,
      pasteAfter: pasteAfterContinue,
      continueSession: nativeContinue,
      resumeArgs: resume.resumeArgs,
      agentId: agent?.id ?? null,
      chatId: chat.id,
      continuedFrom: previous?.id ?? null,
      ...opts.size,
    });
  }

  private uniqueChatId(base: string): string {
    const taken = new Set(this.core.store.listChats().map((chat) => chat.id));
    const root = slugify(base, 40);
    if (!taken.has(root)) return root;
    let count = 2;
    while (taken.has(`${root}-${count}`)) count += 1;
    return `${root}-${count}`;
  }
}
