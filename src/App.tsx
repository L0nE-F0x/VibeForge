import { Component, useEffect, useState, type ReactNode } from "react";
import { AgentScreen } from "./features/team/AgentScreen.js";
import { ChatScreen } from "./features/team/ChatScreen.js";
import { CodeMode } from "./modes/CodeMode.js";
import { SettingsDrawer } from "./modes/Settings.js";

type Mode = "agent" | "code" | "chat";

export function App() {
  const [mode, setMode] = useState<Mode>("agent");
  const [live, setLive] = useState(0);
  const [settingsOpen, setSettingsOpen] = useState(false);

  useEffect(() => {
    const api = window.forgedesk;
    if (!api) return;
    const tick = () => {
      void api.liveCount().then(setLive).catch(() => setLive(0));
    };
    tick();
    const timer = setInterval(tick, 1000);
    const off = api.onPtyExit(() => tick());
    const onKey = (event: KeyboardEvent) => {
      if (!event.ctrlKey || !event.shiftKey) return;
      if (event.key === "1") setMode("agent");
      if (event.key === "2") setMode("code");
      if (event.key === "3") setMode("chat");
      if (event.key === ",") setSettingsOpen(true);
    };
    window.addEventListener("keydown", onKey);
    return () => {
      clearInterval(timer);
      off();
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  return (
    <div className="fd-app">
      <header className="fd-header">
        <div className="fd-mark"><i />ForgeDesk</div>
        <div className="fd-seg" role="tablist">
          <ModeButton mode="agent" current={mode} onSelect={setMode} />
          <ModeButton mode="code" current={mode} onSelect={setMode} />
          <ModeButton mode="chat" current={mode} onSelect={setMode} />
        </div>
        <div className="fd-grow" />
        {live > 0 && <span className="fd-pill">{live} live</span>}
        <button className="fd-iconbtn" type="button" onClick={() => setSettingsOpen(true)}>Settings</button>
      </header>
      <div className="fd-body">
        <CrashBoundary>
          <div className={mode === "agent" ? "fd-fill" : "fd-hidden"}><AgentScreen /></div>
          <div className={mode === "code" ? "fd-fill" : "fd-hidden"}><CodeMode active={mode === "code"} /></div>
          <div className={mode === "chat" ? "fd-fill" : "fd-hidden"}><ChatScreen /></div>
        </CrashBoundary>
        {settingsOpen && <SettingsDrawer onClose={() => setSettingsOpen(false)} />}
      </div>
    </div>
  );
}

function ModeButton({ mode, current, onSelect }: { mode: Mode; current: Mode; onSelect: (mode: Mode) => void }) {
  const label = mode === "agent" ? "Agent" : mode === "code" ? "Code" : "Chat";
  return (
    <button type="button" role="tab" aria-pressed={current === mode} onClick={() => onSelect(mode)}>
      {label}
    </button>
  );
}

class CrashBoundary extends Component<{ children: ReactNode }, { error: string | null }> {
  state = { error: null as string | null };

  static getDerivedStateFromError(error: Error) {
    return { error: error.message };
  }

  render() {
    if (this.state.error) {
      return (
        <div className="fd-empty">
          <h2>The desk hit a problem.</h2>
          <p className="fd-error">{this.state.error}</p>
        </div>
      );
    }
    return this.props.children;
  }
}
