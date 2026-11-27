import { FolderOpen, MessageSquarePlus, MessagesSquare, Trash2 } from "lucide-react";
import { Fragment, useEffect, useRef, useState } from "react";
import { dayHeading, tildify } from "../../shared/text.js";
import type { ChatView as Chat } from "../../shared/api.js";
import { call, useAppInfo, useChats, useEngines, useSettings } from "../api.js";
import { activeFilterLabels, NoMatch, PickMark } from "../components/ListTools.js";
import { SessionPane } from "../components/Session.js";
import { SidePanel, StripItem } from "../components/SidePanel.js";
import { LoadFailed } from "../components/LoadState.js";
import { Button, Chip, Input, ShortAgo, Skeleton } from "../components/ui.js";
import { tipProps } from "../components/Tooltip.js";
import { useAction, useConfirm, useDeleted, useDropMissing, useNav, type Route } from "../state.js";
import { EngineSelect } from "./Agents.js";
import { CHAT_LIST, useChatList } from "./chat-list.js";
import { useT } from "../i18n/index.js";

export function ChatView({ route }: { route: Extract<Route, { view: "chat" }> }) {
  const t = useT();
  const { go } = useNav();
  const confirm = useConfirm();
  const deleted = useDeleted();
  const chatList = useChats(null);
  const all = chatList.data ?? [];
  const engines = useEngines().data ?? [];
  const settings = useSettings().data;
  const home = useAppInfo().data?.home ?? "";
  const [engine, setEngine] = useState("");
  const [renaming, setRenaming] = useState(false);
  const [title, setTitle] = useState("");
  const skipBlurRef = useRef(false);
  const chat = all.find((item) => item.id === route.chatId) ?? null;
  // A list that couldn't be read says so, and isn't taken for "no chats" (nor drops the one asked for).
  const unreadable = chatList.error !== null && chatList.data === undefined;
  useDropMissing(chatList.loaded && !unreadable, Boolean(route.chatId) && !chat, { view: "chat" });
  const { list, labels, bar, waiting, headingOf } = useChatList(CHAT_LIST, all, (gone) => {
    if (gone.some((item) => item.id === route.chatId)) go({ view: "chat" });
  });
  const { selection } = list;
  const chats = list.shown;

  useEffect(() => {
    if (engine) return;
    const available = engines.filter((item) => item.available);
    const preferred =
      (settings?.local.enabled && settings.local.active ? available.find((item) => item.local) : undefined) ??
      available.find((item) => item.id === settings?.defaultEngine) ??
      available[0];
    if (preferred) setEngine(preferred.id);
  }, [engines, settings, engine]);

  useEffect(() => {
    setRenaming(false);
    setTitle(chat?.title ?? "");
  }, [chat?.id, chat?.title]);

  const [rename] = useAction(async () => {
    if (chat && title.trim() && title !== chat.title) await call("chats.rename", chat.id, title);
    setRenaming(false);
  }, t("chat.renameFailed"));
  const [remove] = useAction(async (target: Chat) => {
    // Deleting is undone from the toast. Only a live session asks first: stopping it can't be undone.
    if (target.live) {
      const ok = await confirm({
        title: t("common.deleteNamed", { name: target.title }),
        body: t("agents.deleteLiveChatBody"),
        confirm: t("common.stopAndDelete"),
        danger: true,
      });
      if (!ok) return;
    }
    const result = await call("chats.delete", target.id);
    if (target.id === route.chatId) go({ view: "chat" });
    deleted(t("common.deletedNamed", { name: target.title }), result);
  }, t("agents.deleteChatFailed"));
  const [switchEngine] = useAction(async (next: string) => {
    if (chat) await call("chats.setEngine", chat.id, next);
    else setEngine(next);
  }, t("chat.engineFailed"));

  const engineLabel = (id: string) => engines.find((item) => item.id === id)?.label ?? id;

  return (
    <div className="view split-list">
      <SidePanel
        id="chat"
        title={t("chat.title")}
        actions={
          <>
            <Button size="sm" icon={MessageSquarePlus} onClick={() => go({ view: "chat" })}>
              {t("common.new")}
            </Button>
          </>
        }
        strip={
          <>
            <StripItem label={t("agents.newChat")} selected={!chat} onClick={() => go({ view: "chat" })}>
              <MessageSquarePlus size={16} />
            </StripItem>
            {list.ordered.slice(0, 14).map((item) => (
              <StripItem key={item.id} label={item.title} selected={item.id === chat?.id} onClick={() => go({ view: "chat", chatId: item.id })} badge={waiting(item.id) ? <span className="ws-state waiting in-strip" /> : undefined}>
                <span className={`dot ${item.live ? "running" : item.lastRun?.status ?? ""}`} />
              </StripItem>
            ))}
          </>
        }
      >
        {bar}
        <div className="list-scroll" onKeyDown={selection.onKeyDown}>
          {!chatList.loaded && <Skeleton rows={5} />}
          <LoadFailed query={chatList} />
          {chatList.loaded && !unreadable && all.length === 0 && <div className="faint" style={{ padding: "12px 10px" }}>{t("chat.none")}</div>}
          {all.length > 0 && chats.length === 0 && <NoMatch hasQuery={list.hasQuery} filters={activeFilterLabels(list, labels)} onClear={list.clear} />}
          {chats.map((item, index) => {
            const heading = headingOf(item);
            const picked = selection.isPicked(item.id);
            const open = () => (selection.selecting ? selection.toggle(item.id) : go({ view: "chat", chatId: item.id }));
            return (
            <Fragment key={item.id}>
            {heading !== null && (index === 0 || headingOf(chats[index - 1]) !== heading) && <div className="list-day">{heading === "live" ? t("session.live") : dayHeading(item.updatedAt, t.language)}</div>}
            <div
              className={`row${waiting(item.id) ? " needs-you" : ""}`}
              role="button"
              tabIndex={0}
              aria-current={(!selection.selecting && item.id === chat?.id) || undefined}
              aria-pressed={selection.selecting ? picked : undefined}
              onClick={open}
              onKeyDown={(event) => {
                if (event.key === "Enter" || (selection.selecting && event.key === " ")) {
                  event.preventDefault();
                  open();
                }
              }}
            >
              {selection.selecting ? <PickMark picked={picked} /> : <span className={`dot ${item.live ? "running" : item.lastRun?.status ?? ""}`} />}
              <span className="vstack grow" style={{ gap: 0 }}>
                <span className="row-title truncate">{item.title}</span>
                <span className="row-sub truncate">
                  {engineLabel(item.engine)} · <ShortAgo iso={item.updatedAt} />
                </span>
              </span>
              {!selection.selecting && (
                <span className="row-actions">
                  <Button size="sm" variant="ghost" icon={Trash2} title={t("common.delete")} onClick={(event) => { event.stopPropagation(); void remove(item); }} />
                </span>
              )}
            </div>
            </Fragment>
            );
          })}
        </div>
      </SidePanel>
      <div className="main">
        <SessionPane
          key={chat?.id ?? "new"}
          chat={chat}
          create={(text) => call("chats.create", { engine, prompt: text })}
          newKey="chat"
          onCreated={(created) => go({ view: "chat", chatId: created.id })}
          placeholder={t("chat.placeholder", { engine: engineLabel(chat?.engine ?? engine) })}
          head={
            <>
              <MessagesSquare size={17} className="accent-text" />
              {chat && renaming ? (
                <Input
                  autoFocus
                  value={title}
                  style={{ maxWidth: 420 }}
                  onChange={(event) => setTitle(event.target.value)}
                  onBlur={() => {
                    if (skipBlurRef.current) {
                      skipBlurRef.current = false;
                      return;
                    }
                    void rename();
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      event.currentTarget.blur();
                    }
                    if (event.key === "Escape") {
                      event.preventDefault();
                      event.stopPropagation();
                      skipBlurRef.current = true;
                      setTitle(chat.title);
                      setRenaming(false);
                    }
                  }}
                />
              ) : chat ? (
                <h1 className="truncate">
                  <button
                    type="button"
                    className="head-title"
                    {...tipProps(t("common.rename"))}
                    onClick={() => {
                      skipBlurRef.current = false;
                      setTitle(chat.title);
                      setRenaming(true);
                    }}
                  >
                    {chat.title}
                  </button>
                </h1>
              ) : (
                <h1 className="truncate">{t("agents.newChat")}</h1>
              )}
            </>
          }
          tools={
            chat && (
              <>
                {chat.live && <Chip tone="accent">{engineLabel(chat.engine)}</Chip>}
                <Button size="sm" icon={FolderOpen} title={`${t("chat.openScratch")} · ${tildify(chat.cwd, home)}`} onClick={() => void call("app.openPath", chat.cwd)} />
              </>
            )
          }
          leading={
            <div className="composer-engine">
              <EngineSelect engines={engines} value={chat?.engine ?? engine} onChange={(next) => void switchEngine(next)} allowMissing={chat?.engine} />
            </div>
          }
          empty={{
            icon: MessagesSquare,
            title: t("chat.empty.title"),
            // Claude Code's folder-trust question is worth a sentence only when it's the one picked.
            body: (chat?.engine ?? engine) === "claude" ? `${t("chat.empty.body")} ${t("chat.empty.claudeTrust")}` : t("chat.empty.body"),
          }}
        />
      </div>
    </div>
  );
}
