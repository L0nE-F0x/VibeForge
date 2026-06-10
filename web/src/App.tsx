import { useState } from "react";
import { useStore } from "./store.ts";
import { Landing } from "./components/Landing.tsx";
import { TopBar } from "./components/TopBar.tsx";
import { IdeaStream } from "./components/IdeaStream.tsx";
import { SpecWorkspace } from "./components/SpecWorkspace.tsx";
import { SettingsModal } from "./components/SettingsModal.tsx";
import { Toasts } from "./components/Toasts.tsx";

export function App() {
  const view = useStore((s) => s.view);
  const setView = useStore((s) => s.setView);
  const [settingsOpen, setSettingsOpen] = useState(false);

  if (view === "landing") return <Landing onEnter={() => setView("studio")} />;

  return (
    <>
      <TopBar onSettings={() => setSettingsOpen(true)} />
      <div className="studio">
        <IdeaStream />
        <SpecWorkspace />
      </div>
      {settingsOpen && <SettingsModal onClose={() => setSettingsOpen(false)} />}
      <Toasts />
    </>
  );
}
