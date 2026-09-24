import { useEffect, useState } from "react";
import type { Settings } from "../core/types.js";
import type { Engine } from "../shared/api.js";

export function SettingsDrawer({ onClose }: { onClose: () => void }) {
  const api = window.forgedesk;
  const [settings, setSettings] = useState<Settings | null>(null);
  const [engines, setEngines] = useState<Engine[]>([]);
  const [paths, setPaths] = useState({ configRoot: "", dataRoot: "" });
  const [bin, setBin] = useState("");
  const [label, setLabel] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void api.getSettings().then(setSettings);
    void api.listEngines().then(setEngines);
    void api.paths().then(setPaths);
  }, [api]);

  async function save(next: Settings) {
    setSettings(await api.saveSettings(next));
  }

  async function recheck() {
    setEngines(await api.recheckEngines());
  }

  async function addEngine() {
    const id = bin.trim();
    if (!id) return;
    const next = [...engines.map(({ id: engineId, label: engineLabel, bin: engineBin, args }) => ({ id: engineId, label: engineLabel, bin: engineBin, args })), { id, label: label.trim() || id, bin: id, args: [] }];
    setEngines(await api.saveEngines(next));
    setBin("");
    setLabel("");
  }

  if (!settings) return null;

  return (
    <div className="fd-drawer">
      <div className="fd-toolbar">
        <strong>Settings</strong>
        <div className="fd-grow" />
        <button className="fd-btn" type="button" onClick={onClose}>Close</button>
      </div>
      <div className="fd-stack">
        <label className="fd-muted">Default engine</label>
        <select className="fd-input" value={settings.defaultEngine} onChange={(event) => void save({ ...settings, defaultEngine: event.target.value })}>
          {engines.map((engine) => <option key={engine.id} value={engine.id}>{engine.label}</option>)}
        </select>
        <label className="fd-muted">Default shell</label>
        <input className="fd-input" value={settings.defaultShell} onChange={(event) => setSettings({ ...settings, defaultShell: event.target.value })} onBlur={() => void save(settings)} />
        <label className="fd-row">
          <input type="checkbox" checked={settings.notify} onChange={(event) => void save({ ...settings, notify: event.target.checked })} />
          Desktop notifications
        </label>
        <button className="fd-btn" type="button" onClick={() => void recheck()}>Recheck CLIs</button>
        {error && <p className="fd-error">{error}</p>}
        <div className="fd-list">
          {engines.map((engine) => (
            <div key={engine.id} className="fd-row" style={{ justifyContent: "space-between" }}>
              <span>{engine.label}</span>
              <span className={engine.available ? "fd-badge on" : "fd-badge"}>{engine.available ? "available" : "missing"}</span>
            </div>
          ))}
        </div>
        <div className="fd-row">
          <input className="fd-input" placeholder="binary name" value={bin} onChange={(event) => setBin(event.target.value)} />
          <input className="fd-input" placeholder="label" value={label} onChange={(event) => setLabel(event.target.value)} />
          <button className="fd-btn" type="button" onClick={() => void addEngine().catch((reason: unknown) => setError(String(reason)))}>Add</button>
        </div>
        <p className="fd-faint">Config<br />{paths.configRoot}</p>
        <p className="fd-faint">Data<br />{paths.dataRoot}</p>
      </div>
    </div>
  );
}
