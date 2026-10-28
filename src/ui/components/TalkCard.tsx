import { call, useEngines, useSettings } from "../api.js";
import { useT } from "../i18n/index.js";
import { useAction } from "../state.js";
import type { AgentTalkSettings } from "../../shared/api.js";
import { Field, Segmented, Select, Toggle } from "./ui.js";

const MAX_MESSAGES = ["4", "8", "12", "20"] as const;
const REVIEW_ROUNDS = ["1", "2", "3"] as const;
const MAX_WORKING = ["1", "2", "3", "5"] as const;
const MAX_HAND_OFFS = ["2", "4", "8"] as const;

/** A segmented choice of counts that keeps a hand-edited value in the list. */
function Counts({ value, choices, disabled, onChange }: { value: number; choices: readonly string[]; disabled: boolean; onChange: (value: number) => void }) {
  return (
    <Segmented
      value={String(value)}
      disabled={disabled}
      options={[...new Set([...choices, String(value)])].sort((a, b) => Number(a) - Number(b)).map((item) => ({ value: item, label: item }))}
      onChange={(item) => onChange(Number(item))}
    />
  );
}

/** Settings → Agents together: CLIs messaging each other and handing out tasks, and how far they go alone. */
export function TalkCard() {
  const t = useT();
  const settings = useSettings().data;
  const engines = useEngines().data ?? [];
  const [save] = useAction(async (agentTalk: AgentTalkSettings) => call("settings.save", { agentTalk }), t("talk.saveFailed"));
  if (!settings) return null;
  const talk = settings.agentTalk;
  return (
    <div className="card vstack" style={{ gap: 14 }}>
      <Field hint={t("settings.agentTalkHint")}>
        <Toggle checked={talk.on} onChange={(on) => void save({ ...talk, on })} label={t("settings.agentTalk")} />
      </Field>
      <div className="form-grid">
        <Field label={t("settings.lead")} hint={t("settings.leadHint")}>
          <Select value={talk.lead} disabled={!talk.on} onChange={(event) => void save({ ...talk, lead: event.target.value })}>
            <option value="">{t("settings.leadNone")}</option>
            {talk.lead && !engines.some((engine) => engine.id === talk.lead) && <option value={talk.lead}>{talk.lead}</option>}
            {engines.map((engine) => (
              <option key={engine.id} value={engine.id}>
                {engine.label}
                {engine.available ? "" : ` ${t("common.notOnPath")}`}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t("settings.handOff")} hint={talk.handOff === "ask" ? t("settings.handOffAskHint") : t("settings.handOffGoHint")}>
          <Segmented
            value={talk.handOff}
            disabled={!talk.on}
            options={[
              { value: "ask", label: t("settings.handOffAsk") },
              { value: "go", label: t("settings.handOffGo") },
            ]}
            onChange={(handOff) => void save({ ...talk, handOff })}
          />
        </Field>
        <Field label={t("settings.maxWorking")} hint={t("settings.maxWorkingHint")}>
          <Counts value={talk.maxWorking} choices={MAX_WORKING} disabled={!talk.on} onChange={(maxWorking) => void save({ ...talk, maxWorking })} />
        </Field>
        <Field label={t("settings.maxHandOffs")} hint={t("settings.maxHandOffsHint")}>
          <Counts value={talk.maxHandOffs} choices={MAX_HAND_OFFS} disabled={!talk.on} onChange={(maxHandOffs) => void save({ ...talk, maxHandOffs })} />
        </Field>
      </div>
      <Field hint={t("settings.leadAppliesHint")}>
        <Toggle checked={talk.leadApplies} disabled={!talk.on} onChange={(leadApplies) => void save({ ...talk, leadApplies })} label={t("settings.leadApplies")} />
      </Field>
      <div className="form-grid">
        <Field label={t("settings.maxMessages")} hint={t("settings.maxMessagesHint")}>
          <Counts value={talk.maxMessages} choices={MAX_MESSAGES} disabled={!talk.on} onChange={(maxMessages) => void save({ ...talk, maxMessages })} />
        </Field>
        <Field label={t("settings.reviewRounds")} hint={t("settings.reviewRoundsHint")}>
          <Counts value={talk.reviewRounds} choices={REVIEW_ROUNDS} disabled={!talk.on} onChange={(reviewRounds) => void save({ ...talk, reviewRounds })} />
        </Field>
      </div>
    </div>
  );
}
