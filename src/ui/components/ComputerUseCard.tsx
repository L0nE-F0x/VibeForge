import { call, useSettings } from "../api.js";
import { useT } from "../i18n/index.js";
import { useAction } from "../state.js";
import type { ComputerUseGrant, ComputerUseSettings } from "../../shared/api.js";
import { Field, Toggle } from "./ui.js";

const PLACES = ["app", "browser", "desktop"] as const;
const GRANTS = ["see", "pointer", "keys"] as const;

/**
 * Settings → Computer use: whether Viby may look at and use the screen, and for each place
 * (VibeForge's window, the Browser in Code, the whole desktop) whether it may see it, click and
 * scroll in it, or type in it. Only this card changes these: Viby's own settings steps can't.
 */
export function ComputerUseCard() {
  const t = useT();
  const settings = useSettings().data;
  const [save] = useAction(async (computerUse: ComputerUseSettings) => call("settings.save", { computerUse }), t("settings.saveFailed"));
  if (!settings) return null;
  const current = settings.computerUse;
  const setGrant = (place: (typeof PLACES)[number], grant: keyof ComputerUseGrant, value: boolean) =>
    void save({ ...current, [place]: { ...current[place], [grant]: value } });
  return (
    <div className="card vstack computer-use-card" style={{ gap: 14 }}>
      <Field hint={t("cu.onHint")}>
        <Toggle checked={current.on} onChange={(on) => void save({ ...current, on })} label={t("cu.on")} />
      </Field>
      <table className="computer-use-grid" style={{ opacity: current.on ? 1 : 0.5 }}>
        <thead>
          <tr>
            <th scope="col">{t("cu.place")}</th>
            {GRANTS.map((grant) => (
              <th key={grant} scope="col">
                {t(`cu.${grant}` as const)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {PLACES.map((place) => (
            <tr key={place}>
              <th scope="row">{t(`cu.${place}` as const)}</th>
              {GRANTS.map((grant) => (
                <td key={grant}>
                  <Toggle
                    checked={current[place][grant]}
                    disabled={!current.on}
                    onChange={(value) => setGrant(place, grant, value)}
                    label={<span className="visually-hidden">{`${t(`cu.${place}` as const)}: ${t(`cu.${grant}` as const)}`}</span>}
                  />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <span className="hint">{t("cu.desktopHint")}</span>
    </div>
  );
}
