import { Copy, Download, FolderOpen, Keyboard, Mic, Square, Volume2 } from "lucide-react";
import { useRef, useState } from "react";
import type { DownloadKind, VoiceSettings, VoiceStatus } from "../../shared/api.js";
import { tildify } from "../../shared/text.js";
import { call, useAppInfo, useSettings } from "../api.js";
import { LANGUAGES, useT } from "../i18n/index.js";
import { Rich } from "../i18n/Rich.js";
import { useAction, useToast } from "../state.js";
import { CONVERSE_KEYS, DICTATE_KEYS, MicButton, useDictationTarget, useVoiceStatus } from "../voice.js";
import { Button, Chip, Field, Notice, Select, Toggle } from "./ui.js";

// Settings → Voice: what dictation and talking back found on this machine, the models and voices
// they use, the keybindings that reach them from anywhere, and a place to try them.

function basename(file: string): string {
  return file.slice(file.lastIndexOf("/") + 1);
}

function StatusRow({ ok, label, detail, children }: { ok: boolean; label: string; detail: string; children?: React.ReactNode }) {
  return (
    <div className="hstack" style={{ gap: 10 }}>
      <span className={`dot ${ok ? "exited" : "failed"}`} />
      <span className="vstack grow" style={{ gap: 1, minWidth: 0 }}>
        <strong>{label}</strong>
        <span className="faint mono truncate" style={{ fontSize: "var(--fs-xs)" }}>
          {detail}
        </span>
      </span>
      {children}
    </div>
  );
}

/** Download buttons for one catalog, with the progress of whatever is downloading. */
function Downloads({ status, kind, items, hint }: { status: VoiceStatus; kind: DownloadKind; items: Array<{ id: string; mb: number; path: string | null; tip: string }>; hint: string }) {
  const t = useT();
  const [start] = useAction(async (id: string) => call("voice.download", kind, id), t("voice.downloadFailed"));
  const download = status.download;
  const mine = download?.kind === kind ? download : null;
  return (
    <div className="vstack" style={{ gap: 8 }}>
      <div className="hstack wrap" style={{ gap: 6 }}>
        {items.map((item) => (
          <Button key={item.id} size="sm" icon={Download} disabled={Boolean(item.path) || Boolean(download)} busy={mine?.id === item.id} tip={item.tip} onClick={() => void start(item.id)}>
            {item.id} · {item.mb} MB{item.path ? " ✓" : ""}
          </Button>
        ))}
      </div>
      {mine && (
        <div className="hstack" style={{ gap: 10 }}>
          <div className="voice-progress grow">
            <i style={{ width: `${Math.min(100, (mine.received / Math.max(1, mine.total)) * 100).toFixed(1)}%` }} />
          </div>
          <span className="mono faint" style={{ fontSize: "var(--fs-xs)" }}>
            {Math.round(mine.received / 1_000_000)} / {Math.round(mine.total / 1_000_000)} MB
          </span>
          <Button size="sm" variant="ghost" icon={Square} onClick={() => void call("voice.stopDownload")}>
            {t("common.cancel")}
          </Button>
        </div>
      )}
      {status.downloadError && !download && (
        <Notice tone="bad">
          {t("voice.downloadFailed")}: {status.downloadError}
        </Notice>
      )}
      <span className="faint" style={{ fontSize: "var(--fs-sm)" }}>
        {hint}
      </span>
    </div>
  );
}

/** Dictate into a scratch line, to see how well the model does before trusting it with a prompt. */
function TryIt() {
  const t = useT();
  const [heard, setHeard] = useState("");
  const line = useRef<HTMLDivElement>(null);
  const target = useDictationTarget(() => ({
    label: t("voice.tryLabel"),
    element: () => line.current,
    insert: (text) => setHeard(text),
  }));
  return (
    <div ref={line} className="hstack voice-try" onFocusCapture={target.onFocusCapture}>
      <MicButton target={target.target} />
      <span className={`grow selectable ${heard ? "" : "faint"}`}>{heard || t("voice.tryEmpty")}</span>
    </div>
  );
}

export function VoiceCard() {
  const t = useT();
  const { push } = useToast();
  const settings = useSettings().data;
  const status = useVoiceStatus().data;
  const home = useAppInfo().data?.home ?? "";
  const [patch] = useAction(async (next: Partial<VoiceSettings>) => {
    if (settings) await call("settings.save", { voice: { ...settings.voice, ...next } });
  }, t("voice.saveFailed"));
  const [install, installing] = useAction(async () => {
    const file = await call("voice.installBindings");
    push("success", t("voice.bindingsAdded"), tildify(file, home));
  }, t("voice.bindingsFailed"));
  if (!settings || !status) return null;
  const voice = settings.voice;
  const whisper = status.server ?? status.cli;
  const englishOnly = status.model ? /\.en([.-]|\.bin$)/i.test(basename(status.model)) : false;
  const canSpeak = Boolean(status.piper && status.player && status.speaker);

  return (
    <div className="vstack" style={{ gap: 14 }}>
      <div className="card vstack" style={{ gap: 14 }}>
        <Notice icon={Mic}>{t("voice.privacy")}</Notice>
        <div className="vstack" style={{ gap: 10 }}>
          <StatusRow ok={Boolean(status.recorder)} label={t("voice.recorder")} detail={status.recorder ?? t("voice.recorderMissing")} />
          <StatusRow ok={Boolean(whisper)} label="whisper.cpp" detail={whisper ? `${tildify(whisper, home)}${status.server ? "" : ` · ${t("voice.cliOnly")}`}` : t("voice.whisperMissing")}>
            {!whisper && <code className="selectable mono">sudo pacman -S whisper-cpp</code>}
          </StatusRow>
          <StatusRow ok={Boolean(status.model)} label={t("voice.model")} detail={status.model ? tildify(status.model, home) : t("voice.modelMissing")}>
            {status.model && <Button size="sm" variant="ghost" icon={FolderOpen} tip={t("common.openFileManager")} onClick={() => void call("app.openPath", status.model!.replace(/\/[^/]+$/, ""))} />}
          </StatusRow>
        </div>

        <div className="form-grid">
          <Field label={t("voice.model")} hint={status.models.length ? t("voice.modelHint") : undefined}>
            <Select value={status.models.includes(voice.model) ? voice.model : ""} onChange={(event) => void patch({ model: event.target.value })} disabled={!status.models.length}>
              <option value="">{status.model && !status.models.includes(voice.model) ? t("voice.modelBest", { name: basename(status.model) }) : t("voice.modelAuto")}</option>
              {status.models.map((file) => (
                <option key={file} value={file}>
                  {basename(file)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t("voice.language")} hint={englishOnly ? t("voice.englishOnlyHint") : t("voice.languageHint")}>
            <Select value={voice.language} disabled={englishOnly} onChange={(event) => void patch({ language: event.target.value })}>
              <option value="auto">{t("voice.languageAuto")}</option>
              {LANGUAGES.map((language) => (
                <option key={language.code} value={language.code}>
                  {language.name}
                </option>
              ))}
            </Select>
          </Field>
        </div>

        <Field label={t("voice.getModel")}>
          <Downloads
            status={status}
            kind="model"
            items={status.catalog.map((choice) => ({ ...choice, tip: choice.englishOnly ? t("voice.englishOnly") : t("voice.multilingual") }))}
            hint={t("voice.downloadHint", { dir: tildify(status.modelDir, home) })}
          />
        </Field>

        <Field hint={t("voice.autoSendHint")}>
          <Toggle checked={voice.autoSend} onChange={(autoSend) => void patch({ autoSend })} label={t("voice.autoSend")} />
        </Field>

        <Field label={t("voice.try")} hint={<Rich text={t("voice.tryHint", { keys: DICTATE_KEYS })} />}>
          {status.ready ? <TryIt /> : <Chip tone="warn">{t("voice.notReady")}</Chip>}
        </Field>
      </div>

      <div className="section-title">
        <Volume2 size={13} /> {t("voice.talkTitle")}
      </div>
      <div className="card vstack" style={{ gap: 14 }}>
        <span className="faint">{t("voice.talkIntro")}</span>
        <div className="vstack" style={{ gap: 10 }}>
          <StatusRow ok={Boolean(status.piper)} label="Piper" detail={status.piper ? tildify(status.piper, home) : t("voice.piperMissing")}>
            {!status.piper && <code className="selectable mono">uv tool install piper-tts</code>}
          </StatusRow>
          <StatusRow ok={Boolean(status.player)} label={t("voice.player")} detail={status.player ?? t("voice.playerMissing")} />
          <StatusRow ok={Boolean(status.speaker)} label={t("voice.voice")} detail={status.speaker ? tildify(status.speaker, home) : t("voice.voiceMissing")} />
        </div>
        <div className="form-grid">
          <Field label={t("voice.talkBack")} hint={t("voice.talkBackHint")}>
            <Select value={voice.talkBack} onChange={(event) => void patch({ talkBack: event.target.value as VoiceSettings["talkBack"] })}>
              <option value="summary">{t("voice.talkBack.summary")}</option>
              <option value="full">{t("voice.talkBack.full")}</option>
              <option value="off">{t("voice.talkBack.off")}</option>
            </Select>
          </Field>
          <Field label={t("voice.voice")} hint={t("voice.voiceHint")}>
            <div className="hstack" style={{ gap: 6 }}>
              <Select value={status.voices.includes(voice.speaker) ? voice.speaker : ""} onChange={(event) => void patch({ speaker: event.target.value })} disabled={!status.voices.length}>
                <option value="">{status.speaker && !status.voices.includes(voice.speaker) ? t("voice.voiceAutoNamed", { name: basename(status.speaker).replace(/\.onnx$/, "") }) : t("voice.voiceAuto")}</option>
                {status.voices.map((file) => (
                  <option key={file} value={file}>
                    {basename(file).replace(/\.onnx$/, "")}
                  </option>
                ))}
              </Select>
              <Button
                icon={status.speaking ? Square : Volume2}
                disabled={!canSpeak}
                tip={status.speaking ? t("voice.silence") : t("voice.hearIt")}
                onClick={() => void (status.speaking ? call("voice.silence") : call("voice.speak", t("voice.sample")))}
              />
            </div>
          </Field>
        </div>
        <Field label={t("voice.getVoice")}>
          <Downloads
            status={status}
            kind="voice"
            items={status.voiceCatalog.map((choice) => ({ ...choice, tip: LANGUAGES.find((language) => language.code === choice.language)?.name ?? choice.language }))}
            hint={t("voice.voiceDownloadHint", { dir: tildify(status.voiceDir, home) })}
          />
        </Field>
      </div>

      <div className="section-title">
        <Keyboard size={13} /> {t("voice.anywhereTitle")}
      </div>
      <div className="card vstack" style={{ gap: 12 }}>
        <span className="faint">
          <Rich text={t("voice.anywhereIntro", { converse: CONVERSE_KEYS })} />
        </span>
        <pre className="about-env selectable">{status.hyprland.text}</pre>
        <div className="hstack wrap" style={{ gap: 8 }}>
          <Button variant={status.hyprland.installed ? "default" : "primary"} icon={Keyboard} busy={installing} disabled={status.hyprland.installed} onClick={() => void install()}>
            {status.hyprland.installed ? t("voice.bindingsInstalled") : t("voice.addBindings")}
          </Button>
          <Button icon={Copy} onClick={() => void call("app.copyText", status.hyprland.text).then(() => push("success", t("voice.copied")))}>
            {t("voice.copyBindings")}
          </Button>
          <span className="faint mono" style={{ fontSize: "var(--fs-xs)" }}>
            {tildify(status.hyprland.file, home)}
          </span>
        </div>
        <span className="faint" style={{ fontSize: "var(--fs-sm)" }}>
          <Rich text={t("voice.commandsHint")} />
        </span>
      </div>
    </div>
  );
}
