import { Trash2 } from "lucide-react";
import type { ChatView } from "../../shared/api.js";
import { dayKey } from "../../shared/text.js";
import { call, useEngines } from "../api.js";
import { useChatAttention } from "../attention.js";
import { ListBar, useList, type ListLabels, type ListRules } from "../components/ListTools.js";
import { Button } from "../components/ui.js";
import { useT } from "../i18n/index.js";
import { matchesQuery, nameOrder, runWentWrong, timeOf, type ListSpec } from "../list-view.js";
import { deleteEach, useAction, useConfirm, useDeleted, useDeletedMany } from "../state.js";

// The chats in Chat and on an agent's Chats tab: the same search, Filter and sort, and Select
// to delete several, as every list has (components/ListTools.tsx).

type ChatFilter = "live" | "waiting" | "failed";
type ChatSort = "recent" | "oldest" | "name" | "engine";
const FILTERS: readonly ChatFilter[] = ["live", "waiting", "failed"];

/** Chat's own chats, each with whichever CLI it was started with. */
export const CHAT_LIST: ListSpec<ChatFilter, ChatSort> = { key: "chats", filters: FILTERS, sorts: ["recent", "oldest", "name", "engine"], defaultSort: "recent" };
/** An agent's chats, all with the agent's CLI, so there is no sorting by CLI. */
export const AGENT_CHAT_LIST: ListSpec<ChatFilter, ChatSort> = { key: "agent-chats", filters: FILTERS, sorts: ["recent", "oldest", "name"], defaultSort: "recent" };

/**
 * A chat list's tools and what it shows. `onGone` hears which chats a delete took, before the
 * list reloads, so the view can leave one that was open.
 */
export function useChatList(spec: ListSpec<ChatFilter, ChatSort>, chats: readonly ChatView[], onGone: (gone: ChatView[]) => void) {
  const t = useT();
  const confirm = useConfirm();
  const deleted = useDeleted();
  const deletedMany = useDeletedMany();
  const engines = useEngines().data ?? [];
  const chatAttention = useChatAttention();
  const waiting = (id: string) => chatAttention.get(id)?.attention === "waiting";
  const engineLabel = (id: string) => engines.find((item) => item.id === id)?.label ?? id;
  const collator = nameOrder(t.language);
  const newestFirst = (a: ChatView, b: ChatView) => timeOf(b.updatedAt) - timeOf(a.updatedAt);
  const rules: ListRules<ChatView, ChatFilter, ChatSort> = {
    test: (filter, chat) => (filter === "live" ? chat.live : filter === "waiting" ? waiting(chat.id) : Boolean(chat.lastRun && !chat.live && runWentWrong(chat.lastRun))),
    search: (query, chat) => matchesQuery(query, chat.title, engineLabel(chat.engine)),
    compare: (sort, a, b) => {
      if (sort === "oldest") return -newestFirst(a, b);
      if (sort === "name") return collator.compare(a.title, b.title);
      if (sort === "engine") return collator.compare(engineLabel(a.engine), engineLabel(b.engine)) || newestFirst(a, b);
      // Live chats first, then the rest by when they were last used.
      return Number(b.live) - Number(a.live) || newestFirst(a, b);
    },
  };
  const list = useList(spec, chats, rules, (chat) => chat.id);
  const { selection } = list;
  const labels: ListLabels<ChatFilter, ChatSort> = {
    filters: { live: t("list.filter.live"), waiting: t("list.filter.waiting"), failed: t("list.filter.failed") },
    sorts: { recent: t("list.sort.recent"), oldest: t("list.sort.oldest"), name: t("list.sort.name"), engine: t("list.sort.engine") },
    sortChips: { oldest: t("list.sortShort.oldest"), name: t("list.sortShort.name"), engine: t("list.sortShort.engine") },
  };

  const [deletePicked, deleting] = useAction(async () => {
    const picked = selection.picked;
    if (!picked.length) return;
    // Deleting is undone from the toast. Only a live session asks first: stopping it can't be undone.
    const live = picked.filter((chat) => chat.live).length;
    if (live) {
      const one = picked.length === 1;
      const ok = await confirm({
        title: one ? t("common.deleteNamed", { name: picked[0].title }) : t.count("chat.deleteManyTitle", picked.length),
        body: one ? t("agents.deleteLiveChatBody") : t.count("list.deleteLiveBody", live),
        confirm: t("common.stopAndDelete"),
        danger: true,
      });
      if (!ok) return;
    }
    const { gone, deleted: undo, error } = await deleteEach(picked, (chat) => call("chats.delete", chat.id));
    if (gone.length) onGone(gone);
    if (gone.length === 1) deleted(t("common.deletedNamed", { name: gone[0].title }), undo[0]);
    else deletedMany(t.count("chat.deletedMany", gone.length), undo);
    if (error) throw error;
    selection.setSelecting(false);
  }, t("agents.deleteChatFailed"));

  const bar = (
    <ListBar
      list={list}
      labels={labels}
      placeholder={t("chat.search")}
      selectTip={t("list.selectDeleteTip")}
      actions={
        <Button size="sm" variant="danger" icon={Trash2} busy={deleting} disabled={!selection.picked.length} onClick={() => void deletePicked()} tip={t("list.deleteSelectedTip")}>
          {t("common.delete")}
        </Button>
      }
    />
  );
  /** The heading a chat goes under: Live, or its day. Only the time sorts have headings. */
  const headingOf = (chat: ChatView): string | null =>
    list.view.sort === "recent" ? (chat.live ? "live" : dayKey(chat.updatedAt)) : list.view.sort === "oldest" ? dayKey(chat.updatedAt) : null;
  return { list, labels, bar, waiting, engineLabel, headingOf };
}
