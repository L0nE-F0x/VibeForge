import { call, useSettings } from "../api.js";
import { useT } from "../i18n/index.js";
import { useAction } from "../state.js";
import type { AgentTalkSettings } from "../../shared/api.js";
import { Field, Segmented, Toggle } from "./ui.js";

const MAX_MESSAGES = ["4", "8", "12", "20"] as const;
const REVIEW_ROUNDS = ["1", "2", "3"] as const;

/** Settings → Agents together: CLIs messaging each other and handing out tasks, and how far they go alone. */
export function TalkCard() {
  const t = useT();
  const settings = useSettings().data;
  const [save] = useAction(async (agentTalk: AgentTalkSettings) => call("settings.save", { agentTalk }), t("talk.saveFailed"));
  if (!settings) return null;
  const talk = settings.agentTalk;
  return (
    <div className="card vstack" style={{ gap: 14 }}>
      <Field hint={t("settings.agentTalkHint")}>
        <Toggle checked={talk.on} onChange={(on) => void save({ ...talk, on })} label={t("settings.agentTalk")} />
      </Field>
      <div className="form-grid">
        <Field label={t("settings.maxMessages")} hint={t("settings.maxMessagesHint")}>
          <Segmented
            value={String(talk.maxMessages)}
            disabled={!talk.on}
            options={[...new Set([...MAX_MESSAGES, String(talk.maxMessages)])].map((value) => ({ value, label: value }))}
            onChange={(value) => void save({ ...talk, maxMessages: Number(value) })}
          />
        </Field>
        <Field label={t("settings.reviewRounds")} hint={t("settings.reviewRoundsHint")}>
          <Segmented
            value={String(talk.reviewRounds)}
            disabled={!talk.on}
            options={[...new Set([...REVIEW_ROUNDS, String(talk.reviewRounds)])].map((value) => ({ value, label: value }))}
            onChange={(value) => void save({ ...talk, reviewRounds: Number(value) })}
          />
        </Field>
      </div>
    </div>
  );
}
