import { Activity, ArrowDown, ArrowUp, Bell, Bug, Check, Compass, Download, FolderOpen, HardDrive, Keyboard, LifeBuoy, Lightbulb, Mic, Minus, PanelLeft, Palette as PaletteIcon, Pencil, Plus, RefreshCw, Save, Settings as SettingsIcon, Power, Smartphone, SquareTerminal, Stethoscope, Trash2, Volume2, X } from "lucide-react";
import { useEffect, useState } from "react";
import type { Engine, EngineRow, Settings } from "../../shared/api.js";
import { joinArgs, splitArgs } from "../../shared/text.js";
import { call, useActivity, useAppInfo, useEngines, useSettings, useUpdate } from "../api.js";
import { Credit, environmentText, issueUrl, SHOW_SHORTCUTS_EVENT, useCopyDiagnostics } from "../components/Help.js";
import { checkedAt, installText, showUpdate, updateStatus } from "../components/Update.js";
import { LANGUAGES, systemLanguageName } from "../i18n/index.js";
import { startTour } from "../components/Tour.js";
import { CompanionCard } from "../components/CompanionCard.js";
import { SoundsCard } from "../components/SoundsCard.js";
import { StorageCard } from "../components/StorageCard.js";
import { TrayCard } from "../components/TrayCard.js";
import { VoiceCard } from "../components/VoiceCard.js";
import { Button, Chip, Field, Input, Notice, Segmented, Select, Toggle } from "../components/ui.js";
import { usePalette } from "../theme.js";
import { PINNED, railViews, type RailView } from "../rail.js";
import { useAction, useToast } from "../state.js";
import { useT } from "../i18n/index.js";

function toRow(engine: Engine | EngineRow): EngineRow {
  const row: EngineRow = { id: engine.id, label: engine.label, bin: engine.bin, args: engine.args };
  if (engine.promptArgs?.length) row.promptArgs = engine.promptArgs;
  if (engine.continueArgs?.length) row.continueArgs = engine.continueArgs;
  return row;
}

function EngineEditor({ engine, onSave, onCancel, isNew }: { engine: EngineRow; onSave: (row: EngineRow) => void; onCancel: () => void; isNew?: boolean }) {
  const t = useT();
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
          <Field label={t("engine.id")} hint={t("engine.idHint")}>
            <Input autoFocus value={id} placeholder="aider" onChange={(event) => setId(event.target.value.trim())} />
          </Field>
        )}
        <Field label={t("engine.label")}>
          <Input value={label} onChange={(event) => setLabel(event.target.value)} />
        </Field>
        <Field label={t("engine.binary")} hint={t("engine.binaryHint")}>
          <Input className="mono" value={bin} onChange={(event) => setBin(event.target.value)} />
        </Field>
        <Field label={t("engine.args")} hint={t("engine.argsHint")}>
          <Input className="mono" value={args} onChange={(event) => setArgs(event.target.value)} />
        </Field>
        <Field
          label={t("engine.prompt")}
          hint={badPrompt ? undefined : t("engine.promptHint", { prompt: "{prompt}" })}
          error={badPrompt ? t("engine.promptMissing", { prompt: "{prompt}" }) : undefined}
        >
          <Input className="mono" value={promptArgs} placeholder="{prompt}" onChange={(event) => setPromptArgs(event.target.value)} />
        </Field>
        <Field label={t("engine.continue")} hint={t("engine.continueHint")}>
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
          {isNew ? t("engine.add") : t("engine.save")}
        </Button>
        <Button variant="ghost" onClick={onCancel}>
          {t("common.cancel")}
        </Button>
      </div>
    </div>
  );
}

/** Which views the left rail shows, and in what order (Ctrl+1…9 follow it). */
function RailCard({ rail, onChange }: { rail: Settings["rail"]; onChange: (rail: Settings["rail"]) => void }) {
  const t = useT();
  const { all, hidden } = railViews(rail);
  const order = all.map((item) => item.view);
  const move = (view: RailView, by: number) => {
    const next = order.slice();
    const from = next.indexOf(view);
    const to = from + by;
    if (to < 0 || to >= next.length) return;
    [next[from], next[to]] = [next[to], next[from]];
    onChange({ order: next, hidden: [...hidden] });
  };
  const show = (view: RailView, on: boolean) =>
    onChange({ order, hidden: on ? [...hidden].filter((item) => item !== view) : [...hidden, view] });
  return (
    <div className="card vstack" style={{ gap: 2 }}>
      <p className="faint" style={{ margin: "0 0 8px" }}>{t("settings.railHint")}</p>
      {all.map((item, index) => (
        <div key={item.view} className="rail-setting">
          <item.icon size={15} className={hidden.has(item.view) && item.view !== PINNED ? "faint" : "accent-text"} />
          <span className="grow">
            <Toggle checked={item.view === PINNED || !hidden.has(item.view)} disabled={item.view === PINNED} onChange={(on) => show(item.view, on)} label={t(item.label)} />
          </span>
          <Button size="sm" variant="ghost" icon={ArrowUp} tip={t("settings.railUp")} disabled={index === 0} onClick={() => move(item.view, -1)} />
          <Button size="sm" variant="ghost" icon={ArrowDown} tip={t("settings.railDown")} disabled={index === all.length - 1} onClick={() => move(item.view, 1)} />
        </div>
      ))}
    </div>
  );
}

/** Whether `gh` answered, as whom, or why not. */
function GithubStatus() {
  const t = useT();
  const query = useActivity();
  const [refresh, refreshing] = useAction(async () => {
    await call("activity.get", true);
    await query.reload();
  });
  const activity = query.data;
  if (!activity || activity.source !== "github") return null;
  return (
    <div className="hstack" style={{ gap: 8 }}>
      <span className="grow" style={activity.error ? { color: "var(--red)" } : undefined}>
        {activity.error ?? (activity.login ? t("settings.activity.signedIn", { login: activity.login }) : "")}
      </span>
      <Button size="sm" icon={RefreshCw} busy={refreshing} onClick={() => void refresh()}>
        {t("common.refresh")}
      </Button>
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

  const [patch] = useAction(async (next: Partial<Settings>) => call("settings.save", next), t("settings.saveFailed"));
  const [recheck, rechecking] = useAction(async () => {
    const found = await call("engines.recheck");
    push("success", t("settings.rechecked"), t("settings.recheckedBody", { found: found.filter((engine) => engine.available).length, total: found.length }));
  }, t("settings.recheckFailed"));
  const [saveEngines] = useAction(async (next: EngineRow[]) => {
    await call("engines.save", next);
    setEditing(null);
  }, t("settings.enginesFailed"));

  if (!current) return null;
  const available = rows.filter((engine) => engine.available);

  return (
    <div className="main">
      <div className="page-head">
        <SettingsIcon size={17} className="accent-text" />
        <h1 className="grow">{t("settings.title")}</h1>
        <span className="sub">{t("settings.savedTo", { path: info?.configRoot ?? "…" })}</span>
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
            <Field
              label={t("settings.colours")}
              hint={current.theme === "omarchy" ? t("settings.coloursOmarchy", { name: palette?.source === "omarchy" ? palette.name : t("settings.noOmarchyTheme") }) : t("settings.coloursBuiltin")}
            >
              <Segmented
                value={current.theme}
                onChange={(theme) => void patch({ theme })}
                options={[
                  { value: "omarchy", label: t("settings.followOmarchy") },
                  { value: "builtin", label: t("settings.builtin") },
                ]}
              />
            </Field>
            <div className="form-grid">
              <Field label={t("settings.font")}>
                <Input value={font} onChange={(event) => setFont(event.target.value)} onBlur={() => font.trim() && font !== current.terminalFontFamily && void patch({ terminalFontFamily: font.trim() })} />
              </Field>
              <Field label={t("settings.fontSize")}>
                <div className="hstack">
                  <Button icon={Minus} tip={t("settings.smaller")} disabled={current.terminalFontSize <= 8} onClick={() => void patch({ terminalFontSize: current.terminalFontSize - 1 })} />
                  <strong style={{ width: 36, textAlign: "center" }}>{current.terminalFontSize}px</strong>
                  <Button icon={Plus} tip={t("settings.larger")} disabled={current.terminalFontSize >= 32} onClick={() => void patch({ terminalFontSize: current.terminalFontSize + 1 })} />
                </div>
              </Field>
            </div>
          </div>

          <div className="section-title">
            <PanelLeft size={13} /> {t("settings.rail")}
          </div>
          <RailCard rail={current.rail} onChange={(rail) => void patch({ rail })} />

          <div className="section-title">
            <SquareTerminal size={13} /> {t("settings.defaults")}
          </div>
          <div className="card form-grid">
            <Field label={t("settings.defaultEngine")} hint={t("settings.defaultEngineHint")}>
              <Select value={current.defaultEngine} onChange={(event) => void patch({ defaultEngine: event.target.value })}>
                {rows.map((engine) => (
                  <option key={engine.id} value={engine.id}>
                    {engine.label}
                    {engine.available ? "" : ` ${t("common.notOnPath")}`}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={t("settings.shell")}>
              <Input className="mono" value={shell} onChange={(event) => setShell(event.target.value)} onBlur={() => shell.trim() && shell !== current.defaultShell && void patch({ defaultShell: shell.trim() })} />
            </Field>
          </div>

          <div className="section-title" id="settings-voice">
            <Mic size={13} /> {t("voice.title")}
          </div>
          <VoiceCard />

          <div className="section-title">
            <Bell size={13} /> {t("settings.notifications")}
          </div>
          <div className="card hstack">
            <span className="grow">
              <Toggle checked={current.notify} onChange={(notify) => void patch({ notify })} label={t("settings.notify")} />
            </span>
            <Button size="sm" onClick={() => new Notification("VibeForge", { body: t("settings.testNotifyBody") })}>
              {t("settings.testNotify")}
            </Button>
          </div>

          <div className="section-title" id="settings-phone">
            <Smartphone size={13} /> {t("companion.title")}
          </div>
          <CompanionCard />

          <div className="section-title" id="settings-tray">
            <Power size={13} /> {t("tray.title")}
          </div>
          <TrayCard />

          <div className="section-title" id="settings-sounds">
            <Volume2 size={13} /> {t("sounds.title")}
          </div>
          <SoundsCard />

          <div className="section-title">
            <Activity size={13} /> {t("settings.insights")}
          </div>
          <div className="card vstack" style={{ gap: 12 }}>
            <Field hint={t("settings.usageHint")}>
              <Toggle checked={current.usage} onChange={(usage) => void patch({ usage })} label={t("settings.usage")} />
            </Field>
            <Field hint={t("settings.planLimitsHint")}>
              <Toggle checked={current.planLimits} onChange={(planLimits) => void patch({ planLimits })} label={t("settings.planLimits")} />
            </Field>
            <Field hint={current.notify ? t("settings.quotaAlertsHint") : t("settings.quotaAlertsNeedsNotify")}>
              <Toggle checked={current.quotaAlerts} disabled={!current.notify} onChange={(quotaAlerts) => void patch({ quotaAlerts })} label={t("settings.quotaAlerts")} />
            </Field>
            <Field label={t("settings.activity")} hint={t(`settings.activityHint.${current.activity}`)}>
              <Segmented
                value={current.activity}
                options={[
                  { value: "off", label: t("settings.activity.off") },
                  { value: "git", label: t("settings.activity.git") },
                  { value: "github", label: "GitHub" },
                ]}
                onChange={(activity) => void patch({ activity })}
              />
            </Field>
            {current.activity === "github" && <GithubStatus />}
          </div>

          <div className="section-title">
            <SquareTerminal size={13} /> {t("settings.engines")}
            <span className="count">
              {available.length}/{rows.length}
            </span>
            <span className="grow" />
            <Button size="sm" variant="ghost" icon={RefreshCw} busy={rechecking} onClick={() => void recheck()}>
              {t("settings.recheck")}
            </Button>
            <Button size="sm" variant="ghost" icon={Plus} onClick={() => setEditing("__new__")}>
              {t("settings.add")}
            </Button>
          </div>
          <Notice>{t("settings.keysNote")}</Notice>
          {editing === "__new__" && (
            <EngineEditor
              isNew
              engine={{ id: "", label: "", bin: "", args: [], promptArgs: ["{prompt}"] }}
              onCancel={() => setEditing(null)}
              onSave={(row) => {
                if (rows.some((engine) => engine.id === row.id)) {
                  push("error", t("settings.idTaken"));
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
                        {engine.path ?? t("settings.notFound", { bin: engine.bin })}
                      </span>
                    </span>
                    <span className="faint mono" style={{ fontSize: "var(--fs-xs)" }}>
                      {[engine.bin, ...engine.args].join(" ")}
                      {engine.promptArgs?.length ? ` ${joinArgs(engine.promptArgs)}` : ""}
                    </span>
                  </span>
                  <Chip tone={engine.promptArgs?.length ? "ok" : "warn"} title={engine.promptArgs?.length ? t("settings.promptArg") : t("settings.promptPaste")}>
                    {engine.promptArgs?.length ? t("settings.promptArgChip") : t("settings.promptPasteChip")}
                  </Chip>
                  {engine.continueArgs?.length ? <Chip title={joinArgs(engine.continueArgs)}>{t("settings.continueChip")}</Chip> : null}
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
              [t("settings.config"), info?.configRoot ?? "", t("settings.configHint")],
              [t("settings.data"), info?.dataRoot ?? "", t("settings.dataHint")],
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
                  {t("common.open")}
                </Button>
              </div>
            ))}
            {!info?.hostRunning && (
              <Notice tone="bad" icon={X}>
                {t("settings.hostDownNote")}
              </Notice>
            )}
          </div>

          <div className="section-title" id="settings-storage">
            <HardDrive size={13} /> {t("storage.title")}
          </div>
          <StorageCard />

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
