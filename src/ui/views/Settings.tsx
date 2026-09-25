import { Bell, Bug, Check, Compass, Download, FolderOpen, Keyboard, LifeBuoy, Lightbulb, Minus, Palette as PaletteIcon, Pencil, Plus, RefreshCw, Save, Settings as SettingsIcon, SquareTerminal, Stethoscope, Trash2, X } from "lucide-react";
import { useEffect, useState } from "react";
import type { Engine, EngineRow, Settings } from "../../shared/api.js";
import { joinArgs, splitArgs } from "../../shared/text.js";
import { call, useAppInfo, useEngines, useSettings, useUpdate } from "../api.js";
import { Credit, environmentText, issueUrl, SHOW_SHORTCUTS_EVENT, useCopyDiagnostics } from "../components/Help.js";
import { checkedAt, installText, showUpdate, updateStatus } from "../components/Update.js";
import { LANGUAGES, systemLanguageName } from "../i18n/index.js";
import { startTour } from "../components/Tour.js";
import { Button, Chip, Field, Input, Notice, Segmented, Select, Toggle } from "../components/ui.js";
import { usePalette } from "../theme.js";
import { useAction, useToast } from "../state.js";
import { useT } from "../i18n/index.js";

function toRow(engine: Engine | EngineRow): EngineRow {
  const row: EngineRow = { id: engine.id, label: engine.label, bin: engine.bin, args: engine.args };
  if (engine.promptArgs?.length) row.promptArgs = engine.promptArgs;
  if (engine.continueArgs?.length) row.continueArgs = engine.continueArgs;
  return row;
}

function EngineEditor({ engine, onSave, onCancel, isNew }: { engine: EngineRow; onSave: (row: EngineRow) => void; onCancel: () => void; isNew?: boolean }) {
  const [id, setId] = useState(engine.id);
  const [label, setLabel] = useState(engine.label);
  const [bin, setBin] = useState(engine.bin);
  const [args, setArgs] = useState(joinArgs(engine.args));
  const [promptArgs, setPromptArgs] = useState(joinArgs(engine.promptArgs));
  const [continueArgs, setContinueArgs] = useState(joinArgs(engine.continueArgs));
  const promptList = splitArgs(promptArgs);
  const badPrompt = promptList.length > 0 && !promptList.some((arg) => arg.includes("{prompt}"));
  return (
    <div className="card vstack" style={{ gap: 12, borderColor: "var(--sel-line)" }}>
      <div className="form-grid">
        {isNew && (
          <Field label="Id" hint="Short and unique, used in agent files.">
            <Input autoFocus value={id} placeholder="aider" onChange={(event) => setId(event.target.value.trim())} />
          </Field>
        )}
        <Field label="Label">
          <Input value={label} onChange={(event) => setLabel(event.target.value)} />
        </Field>
        <Field label="Binary" hint="A name on PATH or an absolute path.">
          <Input className="mono" value={bin} onChange={(event) => setBin(event.target.value)} />
        </Field>
        <Field label="Extra arguments" hint="Always passed, e.g. a model flag.">
          <Input className="mono" value={args} onChange={(event) => setArgs(event.target.value)} />
        </Field>
        <Field
          label="Starting prompt"
          hint={badPrompt ? undefined : "How the first message is passed, with {prompt} where it goes. Empty: VibeForge pastes it once the CLI is ready."}
          error={badPrompt ? "Include {prompt} somewhere." : undefined}
        >
          <Input className="mono" value={promptArgs} placeholder="{prompt}" onChange={(event) => setPromptArgs(event.target.value)} />
        </Field>
        <Field label="Continue session" hint="Arguments that reopen the CLI's latest session in the same folder, e.g. --continue.">
          <Input className="mono" value={continueArgs} placeholder="--continue" onChange={(event) => setContinueArgs(event.target.value)} />
        </Field>
      </div>
      <div className="hstack">
        <Button
          variant="primary"
          icon={Check}
          disabled={!id || !bin.trim() || badPrompt}
          onClick={() =>
            onSave({
              id,
              label: label.trim() || id,
              bin: bin.trim(),
              args: splitArgs(args),
              ...(promptList.length ? { promptArgs: promptList } : {}),
              ...(splitArgs(continueArgs).length ? { continueArgs: splitArgs(continueArgs) } : {}),
            })
          }
        >
          {isNew ? "Add engine" : "Save engine"}
        </Button>
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

export function SettingsView() {
  const t = useT();
  const { push } = useToast();
  const settings = useSettings();
  const engines = useEngines();
  const info = useAppInfo().data;
  const palette = usePalette();
  const [shell, setShell] = useState("");
  const [font, setFont] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const current = settings.data;
  const rows = engines.data ?? [];
  const update = useUpdate().data;
  const copyDiagnostics = useCopyDiagnostics();

  useEffect(() => {
    if (!current) return;
    setShell(current.defaultShell);
    setFont(current.terminalFontFamily);
  }, [current]);

  const [patch] = useAction(async (next: Partial<Settings>) => call("settings.save", next), "Could not save settings");
  const [recheck, rechecking] = useAction(async () => {
    const found = await call("engines.recheck");
    push("success", "CLIs rechecked", `${found.filter((engine) => engine.available).length} of ${found.length} found on PATH.`);
  }, "Could not recheck");
  const [saveEngines] = useAction(async (next: EngineRow[]) => {
    await call("engines.save", next);
    setEditing(null);
  }, "Could not save engines");

  if (!current) return null;
  const available = rows.filter((engine) => engine.available);

  return (
    <div className="main">
      <div className="page-head">
        <SettingsIcon size={17} className="accent-text" />
        <h1 className="grow">{t("settings.title")}</h1>
        <span className="sub">Saved to {info?.configRoot ?? "…"}</span>
      </div>
      <div className="page-body">
        <div className="vstack page-narrow" style={{ gap: 14, maxWidth: 940 }}>
          <div className="section-title">
            <PaletteIcon size={13} /> {t("settings.appearance")}
          </div>
          <div className="card vstack" style={{ gap: 14 }}>
            <Field label={t("settings.language")} hint={t("settings.languageHint")}>
              <Select value={current.language} onChange={(event) => void patch({ language: event.target.value })} style={{ maxWidth: 320 }}>
                <option value="system">{t("settings.languageSystem", { name: systemLanguageName() })}</option>
                {LANGUAGES.map((language) => (
                  <option key={language.code} value={language.code}>
                    {language.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Colours" hint={current.theme === "omarchy" ? `Following Omarchy: ${palette?.source === "omarchy" ? palette.name : "no theme found, using Apex Forge"}. Switching themes restyles VibeForge live.` : "The built-in Apex Forge palette."}>
              <Segmented
                value={current.theme}
                onChange={(theme) => void patch({ theme })}
                options={[
                  { value: "omarchy", label: "Follow Omarchy theme" },
                  { value: "builtin", label: "Built-in Apex Forge" },
                ]}
              />
            </Field>
            <div className="form-grid">
              <Field label="Terminal font">
                <Input value={font} onChange={(event) => setFont(event.target.value)} onBlur={() => font.trim() && font !== current.terminalFontFamily && void patch({ terminalFontFamily: font.trim() })} />
              </Field>
              <Field label="Terminal font size">
                <div className="hstack">
                  <Button icon={Minus} tip={t("settings.smaller")} disabled={current.terminalFontSize <= 8} onClick={() => void patch({ terminalFontSize: current.terminalFontSize - 1 })} />
                  <strong style={{ width: 36, textAlign: "center" }}>{current.terminalFontSize}px</strong>
                  <Button icon={Plus} tip={t("settings.larger")} disabled={current.terminalFontSize >= 32} onClick={() => void patch({ terminalFontSize: current.terminalFontSize + 1 })} />
                </div>
              </Field>
            </div>
          </div>

          <div className="section-title">
            <SquareTerminal size={13} /> {t("settings.defaults")}
          </div>
          <div className="card form-grid">
            <Field label="Default engine" hint="Preselected for new agents, chats and Code launches.">
              <Select value={current.defaultEngine} onChange={(event) => void patch({ defaultEngine: event.target.value })}>
                {rows.map((engine) => (
                  <option key={engine.id} value={engine.id}>
                    {engine.label}
                    {engine.available ? "" : " (not on PATH)"}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Shell for plain terminals">
              <Input className="mono" value={shell} onChange={(event) => setShell(event.target.value)} onBlur={() => shell.trim() && shell !== current.defaultShell && void patch({ defaultShell: shell.trim() })} />
            </Field>
          </div>

          <div className="section-title">
            <Bell size={13} /> {t("settings.notifications")}
          </div>
          <div className="card hstack">
            <span className="grow">
              <Toggle checked={current.notify} onChange={(notify) => void patch({ notify })} label="Notify when a routine or task run finishes" />
            </span>
            <Button size="sm" onClick={() => new Notification("VibeForge", { body: "Notifications reach your desktop." })}>
              Send a test
            </Button>
          </div>

          <div className="section-title">
            <SquareTerminal size={13} /> {t("settings.engines")}
            <span className="count">
              {available.length}/{rows.length}
            </span>
            <span className="grow" />
            <Button size="sm" variant="ghost" icon={RefreshCw} busy={rechecking} onClick={() => void recheck()}>
              Recheck CLIs
            </Button>
            <Button size="sm" variant="ghost" icon={Plus} onClick={() => setEditing("__new__")}>
              Add
            </Button>
          </div>
          <Notice>
            VibeForge never holds model keys: each engine is a CLI on this machine, run with your own login. If a CLI isn't signed in, its own login flow
            shows in the terminal.
          </Notice>
          {editing === "__new__" && (
            <EngineEditor
              isNew
              engine={{ id: "", label: "", bin: "", args: [], promptArgs: ["{prompt}"] }}
              onCancel={() => setEditing(null)}
              onSave={(row) => {
                if (rows.some((engine) => engine.id === row.id)) {
                  push("error", "That id is taken");
                  return;
                }
                void saveEngines([...rows.map(toRow), row]);
              }}
            />
          )}
          <div className="vstack" style={{ gap: 6 }}>
            {rows.map((engine) =>
              editing === engine.id ? (
                <EngineEditor
                  key={engine.id}
                  engine={engine}
                  onCancel={() => setEditing(null)}
                  onSave={(row) => void saveEngines(rows.map((item) => (item.id === engine.id ? row : toRow(item))))}
                />
              ) : (
                <div key={engine.id} className="card hstack" style={{ padding: "9px 12px" }}>
                  <span className={`dot ${engine.available ? "exited" : ""}`} />
                  <span className="vstack grow" style={{ gap: 1 }}>
                    <span className="hstack">
                      <strong>{engine.label}</strong>
                      <span className="faint mono" style={{ fontSize: "var(--fs-xs)" }}>
                        {engine.path ?? `${engine.bin} (not found)`}
                      </span>
                    </span>
                    <span className="faint mono" style={{ fontSize: "var(--fs-xs)" }}>
                      {[engine.bin, ...engine.args].join(" ")}
                      {engine.promptArgs?.length ? ` ${joinArgs(engine.promptArgs)}` : ""}
                    </span>
                  </span>
                  <Chip tone={engine.promptArgs?.length ? "ok" : "warn"} title={engine.promptArgs?.length ? t("settings.promptArg") : t("settings.promptPaste")}>
                    {engine.promptArgs?.length ? "prompt as argument" : "prompt pasted"}
                  </Chip>
                  {engine.continueArgs?.length ? <Chip title={joinArgs(engine.continueArgs)}>continue</Chip> : null}
                  <Button size="sm" variant="ghost" icon={Pencil} onClick={() => setEditing(engine.id)} title={t("common.edit")} />
                  <Button size="sm" variant="ghost" icon={Trash2} onClick={() => void saveEngines(rows.filter((item) => item.id !== engine.id).map(toRow))} title={t("common.remove")} />
                </div>
              ),
            )}
          </div>

          <div className="section-title">
            <FolderOpen size={13} /> {t("settings.files")}
          </div>
          <div className="card vstack" style={{ gap: 8 }}>
            {[
              ["Config", info?.configRoot ?? "", "Agents, skills, routines, tasks, engines.json, settings. Plain YAML and Markdown you can edit anywhere; VibeForge picks up changes."],
              ["Data", info?.dataRoot ?? "", "Runs (prompt, final screen, transcript, git snapshot), chat scratch folders and the run index."],
            ].map(([label, target, hint]) => (
              <div key={label} className="hstack">
                <span className="vstack grow" style={{ gap: 1 }}>
                  <strong>{label}</strong>
                  <span className="mono faint" style={{ fontSize: "var(--fs-sm)" }}>
                    {target}
                  </span>
                  <span className="faint" style={{ fontSize: "var(--fs-sm)" }}>
                    {hint}
                  </span>
                </span>
                <Button size="sm" icon={FolderOpen} onClick={() => void call("app.openPath", target)}>
                  Open
                </Button>
              </div>
            ))}
            {!info?.hostRunning && (
              <Notice tone="bad" icon={X}>
                The terminal host is not running, so no terminal can start. Check that Node is on PATH and restart VibeForge.
              </Notice>
            )}
          </div>

          <div className="section-title">
            <Download size={13} /> {t("updates.title")}
          </div>
          <div className="card vstack" style={{ gap: 12 }}>
            <Field hint={t("updates.autoHint")}>
              <Toggle checked={current.checkUpdates} onChange={(checkUpdates) => void patch({ checkUpdates })} label={t("updates.auto")} />
            </Field>
            {update && (
              <div className="hstack wrap" style={{ gap: 8 }}>
                <span className="vstack grow" style={{ gap: 2 }}>
                  <span style={update.available ? { color: "var(--accent)" } : update.error ? { color: "var(--red)" } : undefined}>
                    {updateStatus(update, t)} <span className="faint">{checkedAt(update, t)}</span>
                  </span>
                  <span className="faint" style={{ fontSize: "var(--fs-sm)" }}>
                    {installText(update, info?.appPath ?? "", t)}
                  </span>
                </span>
                <Button icon={RefreshCw} busy={update.checking} onClick={() => void call("updates.check")}>
                  {t("updates.checkNow")}
                </Button>
                {update.available && (
                  <Button variant="primary" icon={Download} onClick={showUpdate}>
                    {t("updates.see")}
                  </Button>
                )}
              </div>
            )}
          </div>

          <div className="section-title">
            <LifeBuoy size={13} /> {t("settings.help")}
          </div>
          <div className="card vstack" style={{ gap: 14 }}>
            <div className="hstack wrap" style={{ gap: 8 }}>
              <Button icon={Compass} onClick={startTour} tip={t("settings.replayTourTip")}>
                {t("settings.replayTour")}
              </Button>
              <Button icon={Keyboard} kbd="Ctrl+Shift+/" tip={t("settings.shortcutsTip")} onClick={() => window.dispatchEvent(new Event(SHOW_SHORTCUTS_EVENT))}>
                {t("help.shortcuts")}
              </Button>
              <span className="grow" />
              <Button icon={Lightbulb} tip={t("settings.featureTip")} onClick={() => void call("app.openExternal", issueUrl("feature", info, rows))}>
                {t("help.feature")}
              </Button>
              <Button icon={Bug} tip={t("settings.bugTip")} onClick={() => void call("app.openExternal", issueUrl("bug", info, rows))}>
                {t("help.bug")}
              </Button>
            </div>
            <Field label={t("settings.aboutInstall")} hint={t("settings.aboutInstallHint")}>
              <pre className="about-env selectable">{environmentText(info, rows)}</pre>
            </Field>
            <Field label={t("diagnostics.title")} hint={t("diagnostics.hint")}>
              <div className="hstack wrap" style={{ gap: 8 }}>
                <Button icon={Stethoscope} onClick={() => void copyDiagnostics()}>
                  {t("diagnostics.copy")}
                </Button>
                <Button icon={FolderOpen} disabled={!info?.logFile} onClick={() => info && void call("app.openPath", info.logFile.replace(/\/[^/]+$/, ""))}>
                  {t("diagnostics.openLog")}
                </Button>
              </div>
            </Field>
          </div>
          <div className="faint" style={{ fontSize: "var(--fs-sm)", marginTop: 6 }}>
            <Save size={11} /> {t("settings.footer", { version: info?.version ?? "" })} · <Credit />
          </div>
        </div>
      </div>
    </div>
  );
}
