import { Keyboard, MousePointerClick, RotateCcw } from "lucide-react";
import { useEffect, useState } from "react";
import type { VoiceSettings } from "../../shared/api.js";
import { DEFAULT_DICTATE_KEYS, dictateKeysLabel, dictateKeysProblem, sameDictateKeys, type DictateKeys } from "../../shared/dictation.js";
import { useT } from "../i18n/index.js";
import { Rich } from "../i18n/Rich.js";
import { dictateClashes, shortcutLabel } from "../shortcuts.js";
import { clipboardKey } from "../terminal-keys.js";
import { setKeyCapture } from "../voice.js";
import { Button, Field, Notice, Select } from "./ui.js";

// Settings → Voice → Keys and buttons: the keys held to dictate, a mouse button that dictates like
// the mic, and when a Send button stands in for Enter. For dictating from the couch with one hand
// on the mouse.

const MODIFIER_CODE = /^(Control|Shift|Alt|Meta|OS|AltGraph)(Left|Right)?$/;

function Caps({ keys }: { keys: string }) {
  return (
    <span className="tour-caps">
      {keys.split(/\+(?!$)/).map((key) => (
        <kbd key={key}>{key}</kbd>
      ))}
    </span>
  );
}

/** Press new dictate keys: the next key with its modifiers. Esc gives up. */
function KeysPicker({ keys, onPick }: { keys: DictateKeys; onPick: (keys: DictateKeys) => void }) {
  const t = useT();
  const [listening, setListening] = useState(false);
  const [problem, setProblem] = useState("");

  useEffect(() => {
    if (!listening) return;
    setKeyCapture(true);
    const down = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (event.repeat || MODIFIER_CODE.test(event.code)) return;
      if (event.code === "Escape" && !event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey) {
        setListening(false);
        setProblem("");
        return;
      }
      const next: DictateKeys = { code: event.code, ctrl: event.ctrlKey, shift: event.shiftKey, alt: event.altKey, meta: event.metaKey };
      const why = dictateKeysProblem(next);
      if (why) {
        setProblem(t(why === "escape" ? "voice.keysEscape" : "voice.keysNeedModifier"));
        return;
      }
      // The terminal's own copy and paste keys (Ctrl+Shift+C/V, Ctrl/Shift+Insert) as well as the shortcuts.
      const clipboard = clipboardKey(event, true);
      const clash = dictateClashes(event)[0] ?? (clipboard === "copy" ? "terminal.copy" : clipboard ? "terminal.paste" : undefined);
      if (clash) {
        setProblem(t("voice.keysTaken", { keys: dictateKeysLabel(next), what: t(shortcutLabel(clash)) }));
        return;
      }
      setProblem("");
      setListening(false);
      onPick(next);
    };
    // Ahead of the window's own shortcuts, so Ctrl+K picks Ctrl+K instead of opening Go to anything.
    window.addEventListener("keydown", down, true);
    const stop = () => setListening(false);
    window.addEventListener("blur", stop);
    return () => {
      setKeyCapture(false);
      window.removeEventListener("keydown", down, true);
      window.removeEventListener("blur", stop);
    };
  }, [listening, onPick, t]);

  const isDefault = sameDictateKeys(keys, DEFAULT_DICTATE_KEYS);
  return (
    <div className="vstack" style={{ gap: 6 }}>
      <div className="hstack wrap" style={{ gap: 8 }}>
        {listening ? <span className="accent-text">{t("voice.keysPress")}</span> : <Caps keys={dictateKeysLabel(keys)} />}
        <Button size="sm" variant={listening ? "primary" : "default"} icon={Keyboard} onClick={() => setListening((on) => !on)}>
          {listening ? t("common.cancel") : t("voice.keysChange")}
        </Button>
        {!isDefault && !listening && (
          <Button size="sm" variant="ghost" icon={RotateCcw} onClick={() => onPick({ ...DEFAULT_DICTATE_KEYS })}>
            {t("voice.keysDefault", { keys: dictateKeysLabel(DEFAULT_DICTATE_KEYS) })}
          </Button>
        )}
      </div>
      {problem && (
        <Notice tone="bad">{problem}</Notice>
      )}
    </div>
  );
}

export function VoiceKeys({ voice, patch }: { voice: VoiceSettings; patch: (next: Partial<VoiceSettings>) => void }) {
  const t = useT();
  return (
    <>
      <div className="section-title">
        <MousePointerClick size={13} /> {t("voice.keysTitle")}
      </div>
      <div className="card vstack" style={{ gap: 14 }}>
        <span className="faint">{t("voice.keysIntro")}</span>
        <Field label={t("voice.keysLabel")} hint={<Rich text={t("voice.keysHint")} />}>
          <KeysPicker keys={voice.keys} onPick={(keys) => patch({ keys })} />
        </Field>
        <div className="form-grid">
          <Field label={t("voice.mouseLabel")} hint={t("voice.mouseHint")}>
            <Select value={voice.mouseButton} onChange={(event) => patch({ mouseButton: event.target.value as VoiceSettings["mouseButton"] })}>
              <option value="off">{t("voice.mouseOff")}</option>
              <option value="back">{t("shortcuts.button.back")}</option>
              <option value="forward">{t("shortcuts.button.forward")}</option>
              <option value="middle">{t("shortcuts.button.middle")}</option>
            </Select>
          </Field>
          <Field label={t("voice.sendLabel")} hint={t("voice.sendHint")}>
            <Select value={voice.sendButton} onChange={(event) => patch({ sendButton: event.target.value as VoiceSettings["sendButton"] })}>
              <option value="pointer">{t("voice.sendPointer")}</option>
              <option value="always">{t("voice.sendAlways")}</option>
              <option value="off">{t("voice.sendOff")}</option>
            </Select>
          </Field>
        </div>
      </div>
    </>
  );
}
