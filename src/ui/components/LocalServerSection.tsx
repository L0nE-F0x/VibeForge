import { AlertTriangle, FolderOpen, Play, Square } from "lucide-react";
import { useEffect, useState } from "react";
import type { LocalServerView, LocalSettings, SettingsPatch } from "../../shared/api.js";
import { LOCAL_SERVER_PORTS, normalizeLocalUrl, type LocalServerProblem } from "../../shared/local.js";
import type { LocalServerLaunch, LocalServerSettings } from "../../core/types.js";
import { call, useQuery } from "../api.js";
import { useT, type Key } from "../i18n/index.js";
import { useAction } from "../state.js";
import { Button, Chip, Field, Input, Notice, Select, Toggle } from "./ui.js";

/** How many of its last lines the card shows when opened. */
const SHOWN_LINES = 60;

const KIND_LABEL: Record<LocalServerLaunch, Key> = {
  llamacpp: "local.server.kind.llamacpp",
  ollama: "local.server.kind.ollama",
  lmstudio: "local.server.kind.lmstudio",
  command: "local.server.kind.command",
};

const PROBLEM: Record<LocalServerProblem | "busy" | "exited" | "timeout" | "spawn", Key> = {
  noKind: "local.server.problem.noKind",
  noProgram: "local.server.problem.noProgram",
  noModels: "local.server.problem.noModels",
  noCommand: "local.server.problem.noCommand",
  badArgs: "local.server.problem.badArgs",
  busy: "local.server.problem.busy",
  exited: "local.server.problem.exited",
  timeout: "local.server.problem.timeout",
  spawn: "local.server.problem.spawn",
};

/** The usual address of each kind VibeForge starts, on this computer. */
const kindUrl = (kind: LocalServerLaunch) => `http://127.0.0.1:${LOCAL_SERVER_PORTS[kind]}`;
const PRESET_URLS = new Set((["llamacpp", "ollama", "lmstudio"] as const).map(kindUrl));

/** A text setting saved when you leave the box (or press Enter), not on every key. */
function SavedInput({ value, onSave, ...rest }: { value: string; onSave: (value: string) => void; placeholder?: string; className?: string }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  return (
    <Input
      {...rest}
      value={draft}
      spellCheck={false}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => {
        if (draft.trim() !== value) onSave(draft.trim());
      }}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing || event.keyCode === 229) return;
        if (event.key === "Enter") (event.target as HTMLInputElement).blur();
        if (event.key === "Escape") setDraft(value);
      }}
    />
  );
}

/** Settings → Local AI → Run a server: start and stop llama.cpp, Ollama, LM Studio or a command of your own. */
export function LocalServerSection({ local, save }: { local: LocalSettings; save: (patch: NonNullable<SettingsPatch["local"]>) => Promise<unknown> }) {
  const t = useT();
  const query = useQuery<LocalServerView>("local-server", ["localServer", "settings"], () => call("local.server"));
  const view = query.data;
  const [showLog, setShowLog] = useState(false);
  const server = local.server;
  const saveServer = (patch: Partial<LocalServerSettings>) => save({ server: { ...server, ...patch } });

  const [start, starting] = useAction(() => call("local.serverStart"), t("local.server.startFailed"));
  const [stop, stopping] = useAction(() => call("local.serverStop"), t("local.server.stopFailed"));
  const [pickModels] = useAction(async () => {
    const folder = await call("app.pickFolder", t("local.server.models"));
    if (folder) await saveServer({ models: folder });
  }, t("settings.saveFailed"));

  const pickKind = (kind: LocalServerLaunch | "") => {
    const url = normalizeLocalUrl(local.url);
    // The address follows the kind while it is still one of the usual ones (or empty).
    const follow = kind && kind !== "command" && (!url || PRESET_URLS.has(url));
    void save({ server: { ...server, kind }, ...(follow ? { url: kindUrl(kind) } : {}) });
  };

  const state = view?.state;
  const status = state?.status ?? "stopped";
  const up = status === "starting" || status === "running";
  // What's wrong with the settings comes first: a start can't fix that.
  const problem = view?.problem ?? (status === "failed" ? state?.problem : null) ?? null;
  const found = view?.found;
  const lines = state?.log ?? [];

  return (
    <div className="vstack" style={{ gap: 12 }}>
      <div className="vstack" style={{ gap: 2 }}>
        <strong>{t("local.server.title")}</strong>
        <span className="faint" style={{ fontSize: "var(--fs-sm)" }}>
          {t("local.server.intro")}
        </span>
      </div>

      <div className="form-grid">
        <Field label={t("local.server.kind")} hint={t("local.server.kindHint")}>
          <Select value={server.kind} onChange={(event) => pickKind(event.target.value as LocalServerLaunch | "")}>
            <option value="">{t("local.server.kindPick")}</option>
            {(Object.keys(KIND_LABEL) as LocalServerLaunch[]).map((kind) => (
              <option key={kind} value={kind}>
                {t(KIND_LABEL[kind])}
                {kind !== "command" && found && !found[kind] && server.kind !== kind ? ` ${t("local.server.notFound")}` : ""}
              </option>
            ))}
          </Select>
        </Field>

        <Field label={t("local.server.withLocalMode")} hint={t("local.server.withLocalModeHint")}>
          <Toggle checked={server.withLocalMode} disabled={!server.kind} onChange={(withLocalMode) => void saveServer({ withLocalMode })} />
        </Field>

        {server.kind === "llamacpp" && (
          <>
            <Field label={t("local.server.models")} hint={t("local.server.modelsHint")}>
              <div className="hstack" style={{ gap: 6 }}>
                <SavedInput className="mono grow" value={server.models} placeholder="~/AI/models" onSave={(models) => void saveServer({ models })} />
                <Button icon={FolderOpen} onClick={() => void pickModels()}>
                  {t("local.server.choose")}
                </Button>
              </div>
            </Field>
            <Field label={t("local.server.program")} hint={t("local.server.programHint")}>
              <SavedInput className="mono" value={server.program} placeholder="llama-server" onSave={(program) => void saveServer({ program })} />
            </Field>
            <Field label={t("local.server.presets")} hint={t("local.server.presetsHint")}>
              <SavedInput className="mono" value={server.presets} placeholder="~/AI/models/models.ini" onSave={(presets) => void saveServer({ presets })} />
            </Field>
            <Field label={t("local.server.extraArgs")} hint={t("local.server.extraArgsHint")}>
              <SavedInput className="mono" value={server.extraArgs} placeholder="-ngl 99 -fa on -c 65536 --jinja" onSave={(extraArgs) => void saveServer({ extraArgs })} />
            </Field>
          </>
        )}

        {server.kind === "command" && (
          <Field label={t("local.server.command")} hint={t("local.server.commandHint")}>
            <SavedInput className="mono" value={server.command} placeholder="~/AI/run-bonsai.sh" onSave={(command) => void saveServer({ command })} />
          </Field>
        )}
      </div>

      {server.kind && (
        <div className="vstack" style={{ gap: 8 }}>
          <div className="hstack wrap" style={{ gap: 8 }}>
            <Chip tone={status === "running" ? "ok" : status === "failed" ? "bad" : status === "stopped" ? undefined : "info"}>
              {t(`local.server.status.${status}` as Key)}
            </Chip>
            {up || status === "stopping" ? (
              <Button size="sm" icon={Square} busy={stopping || status === "stopping"} onClick={() => void stop()}>
                {t("local.server.stop")}
              </Button>
            ) : (
              <Button size="sm" variant="primary" icon={Play} busy={starting} disabled={Boolean(view?.problem)} onClick={() => void start()}>
                {t("local.server.start")}
              </Button>
            )}
            {up && state?.url && (
              <span className="faint mono" style={{ fontSize: "var(--fs-sm)" }}>
                {state.url}
              </span>
            )}
            {lines.length > 0 && (
              <Button size="sm" variant="ghost" onClick={() => setShowLog((open) => !open)}>
                {showLog ? t("local.server.hideLog") : t("local.server.showLog")}
              </Button>
            )}
          </div>

          {(state?.shown ?? view?.plan?.shown) && (
            <span className="faint mono" style={{ fontSize: "var(--fs-xs)", wordBreak: "break-all" }}>
              $ {up ? state?.shown : (view?.plan?.shown ?? state?.shown)}
            </span>
          )}

          {problem && (
            <Notice tone={view?.problem ? "warn" : "bad"} icon={AlertTriangle}>
              {t(PROBLEM[problem], { detail: state?.detail ?? "", url: state?.url ?? view?.plan?.url ?? "" })}
            </Notice>
          )}

          {showLog && lines.length > 0 && (
            <pre className="pre selectable" style={{ maxHeight: 260, overflow: "auto" }}>
              {lines.slice(-SHOWN_LINES).join("\n")}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}
