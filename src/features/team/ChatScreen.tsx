import { useCallback, useEffect, useState } from "react";
import type { ChatRecord } from "../../core/types.js";
import type { Engine } from "../../shared/api.js";
import { TerminalView } from "../../components/TerminalView.js";

export function ChatScreen() {
  const api = window.forgedesk;
  const [chats, setChats] = useState<ChatRecord[]>([]);
  const [engines, setEngines] = useState<Engine[]>([]);
  const [engineId, setEngineId] = useState("");
  const [active, setActive] = useState<string | null>(null);
  const [ptyId, setPtyId] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState("");

  const load = useCallback(async () => {
    const [all, rows] = await Promise.all([api.listChats(), api.listEngines()]);
    setChats(all.filter((chat) => !chat.agentId));
    setEngines(rows);
    setEngineId((prev) => prev || rows.find((row) => row.available)?.id || "");
  }, [api]);

  useEffect(() => { void load(); }, [load]);

  async function send() {
    const prompt = text.trim();
    if (!prompt) return;
    setError(null);
    try {
      let chatId = active;
      if (!chatId) {
        const created = await api.startChat(engineId);
        chatId = created.id;
        setActive(created.id);
        setRenaming(created.title);
      }
      const sent = await api.sendChat(chatId, prompt);
      if (!sent.ok || !sent.chatId) {
        setError(sent.reason ?? "Could not send.");
        return;
      }
      setActive(sent.chatId);
      setPtyId(sent.ptyId ?? null);
      setNote(sent.startedNew ? sent.message ?? "That session ended. This is a new chat." : null);
      setText("");
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }

  async function remove(id: string) {
    await api.deleteChat(id);
    if (active === id) {
      setActive(null);
      setPtyId(null);
    }
    await load();
  }

  const current = chats.find((chat) => chat.id === active);

  return (
    <div className="fd-fill">
      <aside className="fd-sidebar">
        <div className="fd-side-scroll">
          <p className="fd-kicker">Chat</p>
          <p className="fd-muted">A conversation with no teammate and no project folder.</p>
          <label className="fd-muted">Engine</label>
          <select className="fd-input" value={engineId} onChange={(event) => setEngineId(event.target.value)}>
            {engines.filter((engine) => engine.available).map((engine) => (
              <option key={engine.id} value={engine.id}>{engine.label}</option>
            ))}
          </select>
          <button className="fd-btn" type="button" onClick={() => { setActive(null); setPtyId(null); setNote(null); }}>New chat</button>
          {chats.map((chat) => (
            <button
              key={chat.id}
              className="fd-agentbtn"
              type="button"
              aria-pressed={chat.id === active}
              onClick={() => { setActive(chat.id); setPtyId(chat.ptyId); setRenaming(chat.title); setNote(null); }}
            >
              {chat.title}
            </button>
          ))}
        </div>
      </aside>
      <section className="fd-main">
        {current && (
          <div className="fd-toolbar">
            <input className="fd-input" value={renaming} onChange={(event) => setRenaming(event.target.value)} />
            <button className="fd-btn" type="button" onClick={() => void api.renameChat(current.id, renaming).then(load)}>Rename</button>
            <button className="fd-danger" type="button" onClick={() => void remove(current.id)}>Delete</button>
          </div>
        )}
        {note && <p className="fd-warn" style={{ padding: "8px 10px" }}>{note}</p>}
        {error && <p className="fd-error" style={{ padding: "0 10px" }}>{error}</p>}
        <div className="fd-canvas">
          {ptyId ? <TerminalView ptyId={ptyId} /> : (
            <div className="fd-empty">
              <h2>Ask something that does not belong to a project.</h2>
              <p className="fd-muted">The first send starts a shell for the engine you picked, in an empty scratch folder.</p>
            </div>
          )}
        </div>
        <div className="fd-composer">
          <textarea className="fd-text" style={{ minHeight: 56 }} value={text} onChange={(event) => setText(event.target.value)} placeholder="What do you want back?" />
          <button className="fd-btn-primary" type="button" onClick={() => void send()} disabled={!engineId}>Send</button>
        </div>
      </section>
    </div>
  );
}
