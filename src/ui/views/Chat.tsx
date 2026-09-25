import { FolderOpen, MessageSquarePlus, MessagesSquare, Pencil, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import type { ChatView as Chat } from "../../shared/api.js";
import { call, useChats, useEngines, useSettings } from "../api.js";
import { SessionPane } from "../components/Session.js";
import { SidePanel, StripItem } from "../components/SidePanel.js";
import { Button, Chip, Input, TimeAgo } from "../components/ui.js";
import { useAction, useConfirm, useNav, type Route } from "../state.js";
import { EngineSelect } from "./Agents.js";

export function ChatView({ route }: { route: Extract<Route, { view: "chat" }> }) {
  const { go } = useNav();
  const confirm = useConfirm();
  const chats = useChats(null).data ?? [];
  const engines = useEngines().data ?? [];
  const settings = useSettings().data;
  const [engine, setEngine] = useState("");
  const [renaming, setRenaming] = useState(false);
  const [title, setTitle] = useState("");
  const chat = chats.find((item) => item.id === route.chatId) ?? null;

  useEffect(() => {
    if (engine) return;
    const available = engines.filter((item) => item.available);
    const preferred = available.find((item) => item.id === settings?.defaultEngine) ?? available[0];
    if (preferred) setEngine(preferred.id);
  }, [engines, settings, engine]);

  useEffect(() => {
    setRenaming(false);
    setTitle(chat?.title ?? "");
  }, [chat?.id, chat?.title]);

  const [rename] = useAction(async () => {
    if (chat && title.trim() && title !== chat.title) await call("chats.rename", chat.id, title);
    setRenaming(false);
  }, "Could not rename");
  const [remove] = useAction(async (target: Chat) => {
    const ok = await confirm({
      title: `Delete "${target.title}"?`,
      body: "Its scratch folder and transcripts are deleted. The run records stay in Runs.",
      confirm: "Delete chat",
      danger: true,
    });
    if (!ok) return;
    await call("chats.delete", target.id);
    if (target.id === route.chatId) go({ view: "chat" });
  }, "Could not delete the chat");
  const [switchEngine] = useAction(async (next: string) => {
    if (chat) await call("chats.setEngine", chat.id, next);
    else setEngine(next);
  }, "Could not switch engine");

  const engineLabel = (id: string) => engines.find((item) => item.id === id)?.label ?? id;

  return (
    <div className="view split-list">
      <SidePanel
        id="chat"
        title="Chat"
        actions={
          <>
            <Button size="sm" icon={MessageSquarePlus} onClick={() => go({ view: "chat" })}>
              New
            </Button>
          </>
        }
        strip={
          <>
            <StripItem label="New chat" selected={!chat} onClick={() => go({ view: "chat" })}>
              <MessageSquarePlus size={16} />
            </StripItem>
            {chats.slice(0, 14).map((item) => (
              <StripItem key={item.id} label={item.title} selected={item.id === chat?.id} onClick={() => go({ view: "chat", chatId: item.id })}>
                <span className={`dot ${item.live ? "running" : item.lastRun?.status ?? ""}`} />
              </StripItem>
            ))}
          </>
        }
      >
        <div className="list-scroll">
          {chats.length === 0 && <div className="faint" style={{ padding: "12px 10px" }}>One-off questions live here. Each chat gets its own empty folder.</div>}
          {chats.map((item) => (
            <div
              key={item.id}
              className="row"
              role="button"
              tabIndex={0}
              aria-selected={item.id === chat?.id}
              onClick={() => go({ view: "chat", chatId: item.id })}
              onKeyDown={(event) => event.key === "Enter" && go({ view: "chat", chatId: item.id })}
            >
              <span className={`dot ${item.live ? "running" : item.lastRun?.status ?? ""}`} />
              <span className="vstack grow" style={{ gap: 0 }}>
                <span className="row-title truncate">{item.title}</span>
                <span className="row-sub truncate">
                  {engineLabel(item.engine)} · <TimeAgo iso={item.updatedAt} />
                </span>
              </span>
              <span className="row-actions">
                <Button size="sm" variant="ghost" icon={Trash2} title="Delete" onClick={(event) => { event.stopPropagation(); void remove(item); }} />
              </span>
            </div>
          ))}
        </div>
      </SidePanel>
      <div className="main">
        <div className="page-head">
          <MessagesSquare size={17} className="accent-text" />
          {chat && renaming ? (
            <Input
              autoFocus
              value={title}
              style={{ maxWidth: 420 }}
              onChange={(event) => setTitle(event.target.value)}
              onBlur={() => void rename()}
              onKeyDown={(event) => {
                if (event.key === "Enter") void rename();
                if (event.key === "Escape") setRenaming(false);
              }}
            />
          ) : (
            <h1 className="truncate">{chat ? chat.title : "New chat"}</h1>
          )}
          {chat && !renaming && <Button size="sm" variant="ghost" icon={Pencil} title="Rename" onClick={() => setRenaming(true)} />}
          <span className="grow" />
          {chat?.live ? (
            <Chip tone="accent">{engineLabel(chat.engine)}</Chip>
          ) : (
            <div style={{ width: 190 }}>
              <EngineSelect engines={engines} value={chat?.engine ?? engine} onChange={(next) => void switchEngine(next)} allowMissing={chat?.engine} />
            </div>
          )}
          {chat && <Button size="sm" icon={FolderOpen} title="Open the scratch folder" onClick={() => void call("app.openPath", chat.cwd)} />}
        </div>
        <SessionPane
          key={chat?.id ?? "new"}
          chat={chat}
          create={() => call("chats.create", { engine })}
          onCreated={(created) => go({ view: "chat", chatId: created.id })}
          placeholder={`Ask ${engineLabel(chat?.engine ?? engine)} anything…`}
          empty={{
            icon: MessagesSquare,
            title: "A conversation with no project attached",
            body: "Pick an engine, then ask. The first message opens the CLI in an empty scratch folder; drop files onto the box to hand it paths. Claude Code asks you to trust each new folder once — answer in the terminal.",
          }}
        />
      </div>
    </div>
  );
}
