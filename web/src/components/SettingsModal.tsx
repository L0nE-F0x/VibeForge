import { useState } from "react";
import { PROVIDERS, DEPTHS } from "@vibeforge/shared";
import type { ProviderId, Depth, ProviderConfig } from "@vibeforge/shared";
import { useStore } from "../store.ts";
import { Icon } from "./Icon.tsx";

const TRANSPORT_TAG: Record<string, string> = { proxy: "cloud", direct: "local" };

export function SettingsModal({ onClose }: { onClose: () => void }) {
  const settings = useStore((s) => s.settings);
  const save = useStore((s) => s.saveSettings);
  const toast = useStore((s) => s.toast);

  const [providers, setProviders] = useState<Record<ProviderId, ProviderConfig>>(() => {
    const copy = {} as Record<ProviderId, ProviderConfig>;
    for (const p of PROVIDERS) copy[p.id] = { ...settings.providers[p.id] };
    return copy;
  });
  const [ideationProvider, setIdeation] = useState<ProviderId>(settings.ideationProvider);
  const [specProvider, setSpec] = useState<ProviderId>(settings.specProvider);
  const [grounding, setGrounding] = useState({ ...settings.grounding });
  const [steer, setSteer] = useState(settings.steer);
  const [batch, setBatch] = useState(settings.batch);
  const [depth, setDepth] = useState<Depth>(settings.depth);

  const upd = (id: ProviderId, patch: Partial<ProviderConfig>) =>
    setProviders((prev) => ({ ...prev, [id]: { ...prev[id], ...patch } }));

  function submit() {
    save({ providers, ideationProvider, specProvider, grounding, steer, batch: Math.max(1, Math.min(10, batch || 4)), depth });
    toast({ kind: "", title: "Settings saved" });
    onClose();
  }

  function clearAll() {
    if (!window.confirm("Clear ALL Vibe Forge data in this browser — ideas, specs, settings and keys?")) return;
    localStorage.removeItem("vibeforge.v3");
    location.reload();
  }

  return (
    <div className="modal" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="sheet">
        <div className="mh">
          <h3><Icon name="sliders" size={16} />Studio settings</h3>
          <span className="spacer" style={{ flex: 1 }} />
          <button className="btn icon ghost" onClick={onClose}><Icon name="x" size={16} /></button>
        </div>
        <div className="mbody">
          <div className="section-label">Providers — bring your own key</div>
          <p className="privacy-note">
            Keys are stored <b>only in this browser</b> and travel only inside your own requests —
            cloud calls relay through this site's serverless function straight to the provider;
            local models are called directly from your browser. Nothing is stored or logged server-side.
          </p>

          {PROVIDERS.map((info) => {
            const conf = providers[info.id];
            return (
              <div className="prov" key={info.id}>
                <div className="prov-name">
                  {info.label.split(" (")[0]}
                  <span className={"tb-kind " + (info.transport === "direct" ? "open" : "cli")}>
                    {TRANSPORT_TAG[info.transport]}
                  </span>
                  {!!conf.key && <span className="keytag">key</span>}
                </div>
                <div className="prov-fields">
                  <input
                    className="in"
                    list={"models-" + info.id}
                    placeholder="model id"
                    value={conf.model}
                    onChange={(e) => upd(info.id, { model: e.target.value })}
                  />
                  <datalist id={"models-" + info.id}>
                    {info.models.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
                  </datalist>
                  {!info.keyless && (
                    <input
                      className="in"
                      type="password"
                      autoComplete="off"
                      placeholder={conf.key ? "•••••• (saved — type to replace)" : "API key"}
                      value=""
                      onChange={(e) => { if (e.target.value.trim()) upd(info.id, { key: e.target.value.trim() }); }}
                    />
                  )}
                  {info.baseUrlEditable && (
                    <input
                      className="in mono"
                      placeholder={info.defaultBaseUrl || "https://host/v1"}
                      value={conf.baseUrl ?? ""}
                      onChange={(e) => upd(info.id, { baseUrl: e.target.value })}
                    />
                  )}
                </div>
                {info.hint && <div className="prov-hint">{info.hint}</div>}
              </div>
            );
          })}

          <div className="section-label">Generation</div>
          <div className="row">
            <label className="field"><span>Ideation provider</span>
              <select className="in" value={ideationProvider} onChange={(e) => setIdeation(e.target.value as ProviderId)}>
                {PROVIDERS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
              </select>
            </label>
            <label className="field"><span>Spec provider</span>
              <select className="in" value={specProvider} onChange={(e) => setSpec(e.target.value as ProviderId)}>
                {PROVIDERS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
              </select>
            </label>
          </div>
          <div className="row">
            <label className="field"><span>Idea depth</span>
              <select className="in" value={depth} onChange={(e) => setDepth(e.target.value as Depth)}>
                {DEPTHS.map((d) => <option key={d.id} value={d.id}>{d.label} — {d.hint}</option>)}
              </select>
            </label>
            <label className="field"><span>Ideas / batch</span>
              <input className="in" type="number" min={1} max={10} value={batch} onChange={(e) => setBatch(Number(e.target.value) || 4)} />
            </label>
          </div>
          <label className="field"><span>Creative steering <span className="hint">— optional nudge applied to every batch</span></span>
            <input className="in" value={steer} placeholder="e.g. for indie hackers · dev-tool adjacent · dark, keyboard-first…" onChange={(e) => setSteer(e.target.value)} />
          </label>

          <label className="check"><input type="checkbox" checked={grounding.ideation} onChange={(e) => setGrounding({ ...grounding, ideation: e.target.checked })} /><div><div className="ct">Discover ideas from live web search</div><div className="cd">The model scouts the web (Reddit, Product Hunt, Hacker News, and X on Grok) for real gaps and fresh launches before inventing — instead of relying on its internal seed lists. Best lever against repetitive ideas. Sources are saved on each idea. Cloud providers only (local models can't search).</div></div></label>
          <label className="check"><input type="checkbox" checked={grounding.spec} onChange={(e) => setGrounding({ ...grounding, spec: e.target.checked })} /><div><div className="ct">Ground specs in live web search</div><div className="cd">Lets the spec model look up libraries and techniques while writing. Slower; off by default.</div></div></label>

          <div className="section-label">Danger zone</div>
          <button className="btn danger" onClick={clearAll}><Icon name="trash" size={14} />Clear all local data</button>
        </div>
        <div className="mfoot">
          <button className="btn ghost" onClick={onClose}>Cancel</button>
          <button className="btn primary" onClick={submit}>Save settings</button>
        </div>
      </div>
    </div>
  );
}
