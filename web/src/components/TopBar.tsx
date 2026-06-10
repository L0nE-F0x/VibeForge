import { useStore } from "../store.ts";
import { providerInfo, DEPTHS } from "@vibeforge/shared";
import type { Depth } from "@vibeforge/shared";
import { Icon } from "./Icon.tsx";

export function TopBar({ onSettings }: { onSettings: () => void }) {
  const settings = useStore((s) => s.settings);
  const generating = useStore((s) => s.generating);
  const generateIdeas = useStore((s) => s.generateIdeas);
  const setDepth = useStore((s) => s.setDepth);
  const setView = useStore((s) => s.setView);

  const ideaInfo = providerInfo(settings.ideationProvider);
  const specInfo = providerInfo(settings.specProvider);
  const grounded = settings.grounding.ideation && !!ideaInfo.grounding;

  return (
    <div className="topbar">
      <div className="brand" role="button" title="About Vibe Forge" onClick={() => setView("landing")}>
        <div className="anvil"><Icon name="flame" size={17} /></div>
        <div>
          <span className="bt">Vibe Forge</span>
          <span className="sub">App Idea &amp; Spec Studio</span>
        </div>
      </div>
      <div className="spacer" />

      <span className="pill" title="Model used to generate ideas"><Icon name="sparkles" size={13} />Ideas <b>{ideaInfo.short}</b></span>
      <span className="pill" title="Model used to write specs"><Icon name="file-text" size={13} />Spec <b>{specInfo.short}</b></span>
      {grounded && (
        <span className="pill accent" title="Ideation is grounded in live web search"><Icon name="globe" size={13} />Grounded</span>
      )}

      <select
        className="topselect"
        title="Scope / ambition of each generated batch"
        value={settings.depth}
        onChange={(e) => setDepth(e.target.value as Depth)}
      >
        {DEPTHS.map((d) => <option key={d.id} value={d.id}>Depth: {d.label}</option>)}
      </select>
      <button className="btn primary" disabled={generating} onClick={() => void generateIdeas()}>
        <Icon name="sparkles" size={15} />
        {generating ? "Generating…" : "Generate ideas"}
      </button>
      <button className="btn icon ghost" title="Settings" onClick={onSettings}><Icon name="sliders" size={16} /></button>
    </div>
  );
}
