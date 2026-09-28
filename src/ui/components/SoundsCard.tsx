import { Play } from "lucide-react";
import type { SoundSettings } from "../../shared/api.js";
import { call, useSettings } from "../api.js";
import { useT, type Key } from "../i18n/index.js";
import { previewCue, type Cue } from "../sounds.js";
import { useAction } from "../state.js";
import { Button, Field, Segmented, Toggle } from "./ui.js";

const LEVELS = [
  { value: "soft", volume: 0.3 },
  { value: "medium", volume: 0.6 },
  { value: "loud", volume: 1 },
] as const;

type Level = (typeof LEVELS)[number]["value"];

function levelOf(volume: number): Level {
  return LEVELS.reduce((best, level) => (Math.abs(level.volume - volume) < Math.abs(best.volume - volume) ? level : best)).value;
}

const GROUPS: Array<{ key: "voice" | "attention" | "finished" | "routines"; label: Key; cues: Cue[] }> = [
  { key: "voice", label: "sounds.voice", cues: ["voiceStart", "voiceStop"] },
  { key: "attention", label: "sounds.attention", cues: ["attention"] },
  { key: "finished", label: "sounds.finished", cues: ["finished", "failed"] },
  { key: "routines", label: "sounds.routines", cues: ["routine"] },
];

/** Settings → Sounds: the switch, how loud, which moments, and a way to hear each one. */
export function SoundsCard() {
  const t = useT();
  const sounds = useSettings().data?.sounds;
  const [save] = useAction(async (patch: Partial<SoundSettings>) => {
    const current = (await call("settings.get")).sounds;
    await call("settings.save", { sounds: { ...current, ...patch } });
  }, t("sounds.saveFailed"));
  if (!sounds) return null;

  const hear = (cues: Cue[]) => cues.forEach((name, index) => setTimeout(() => previewCue(name, sounds.volume), index * 650));

  return (
    <div className="card vstack" style={{ gap: 12 }}>
      <Field hint={t("sounds.hint")}>
        <Toggle checked={sounds.on} onChange={(on) => void save({ on })} label={t("sounds.on")} />
      </Field>
      <div className="vstack" style={{ gap: 10, opacity: sounds.on ? 1 : 0.5 }}>
        <Field label={t("sounds.volume")}>
          <Segmented
            value={levelOf(sounds.volume)}
            options={LEVELS.map((level) => ({ value: level.value, label: t(`sounds.level.${level.value}`) }))}
            onChange={(value) => {
              const volume = LEVELS.find((level) => level.value === value)!.volume;
              void save({ volume });
              previewCue("finished", volume);
            }}
          />
        </Field>
        {GROUPS.map((group) => (
          <div key={group.key} className="hstack">
            <span className="grow">
              <Toggle checked={sounds[group.key]} disabled={!sounds.on} onChange={(value) => void save({ [group.key]: value })} label={t(group.label)} />
            </span>
            <Button size="sm" variant="ghost" icon={Play} tip={t("sounds.hear")} onClick={() => hear(group.cues)} />
          </div>
        ))}
        <Field hint={t("sounds.inFrontHint")}>
          <Toggle checked={sounds.inFront} disabled={!sounds.on} onChange={(inFront) => void save({ inFront })} label={t("sounds.inFront")} />
        </Field>
      </div>
    </div>
  );
}
