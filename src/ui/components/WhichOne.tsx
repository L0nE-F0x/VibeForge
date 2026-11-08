import { Signpost, type LucideIcon } from "lucide-react";
import { Fragment, useEffect, useState } from "react";
import { useT, type Key } from "../i18n/index.js";
import { Rich } from "../i18n/Rich.js";
import { VIEWS, type RailView } from "../rail.js";
import { SETTINGS_SECTIONS, type SettingsSection } from "../settings-sections.js";
import { useNav } from "../state.js";
import { Modal } from "./ui.js";

// "Which one do I use?": what you want, and the place in VibeForge for it, one line each. The
// tour shows it as a step and Help opens it as a sheet whose places are links. A reference
// card, not prompts: nothing here starts anything.

export const SHOW_WHICH_ONE_EVENT = "vibeforge:which-one";
export const WhichOneIcon = Signpost;

export function showWhichOne(): void {
  window.dispatchEvent(new Event(SHOW_WHICH_ONE_EVENT));
}

/** A view in the rail, or a section of Settings. Names and icons come from there, so they match. */
export type Place = { view: RailView } | { view: "settings"; section: SettingsSection };

export const WHICH_ONE: Array<{ want: Key; places: Place[] }> = [
  { want: "whichOne.chat", places: [{ view: "chat" }] },
  { want: "whichOne.code", places: [{ view: "code" }] },
  { want: "whichOne.tasks", places: [{ view: "tasks" }] },
  { want: "whichOne.routines", places: [{ view: "routines" }] },
  { want: "whichOne.agents", places: [{ view: "agents" }, { view: "skills" }] },
  { want: "whichOne.maestro", places: [{ view: "orchestrator" }] },
  { want: "whichOne.together", places: [{ view: "settings", section: "together" }] },
  { want: "whichOne.runs", places: [{ view: "runs" }] },
  { want: "whichOne.phone", places: [{ view: "settings", section: "phone" }] },
  { want: "whichOne.voice", places: [{ view: "settings", section: "voice" }] },
];

/** A place's name (the rail's label, or Settings → the section's heading) and its icon. */
export function aboutPlace(place: Place): { label: Key[]; icon: LucideIcon } {
  if (place.view === "settings") {
    const section = SETTINGS_SECTIONS.find((item) => item.id === place.section)!;
    return { label: ["rail.settings", section.label], icon: section.icon };
  }
  const view = VIEWS.find((item) => item.view === place.view)!;
  return { label: [view.label], icon: view.icon };
}

/** The list. With `onGo`, each place is a link that opens it and then calls `onGo`. */
export function WhichOne({ onGo }: { onGo?: () => void }) {
  const t = useT();
  const { go, open } = useNav();
  const visit = (place: Place) => {
    if (place.view === "settings") go(place);
    else open(place.view);
    onGo?.();
  };
  return (
    <div className="which-one">
      {WHICH_ONE.map((row) => {
        const Icon = aboutPlace(row.places[0]).icon;
        return (
          <div key={row.want} className="shortcut-row which-row">
            <Icon size={14} aria-hidden />
            <span className="grow">
              <Rich text={t(row.want)} />
            </span>
            <span className="which-use">
              {row.places.map((place, at) => {
                const name = aboutPlace(place).label.map((key) => t(key)).join(" → ");
                return (
                  <Fragment key={name}>
                    {at > 0 && <span className="faint"> · </span>}
                    {onGo ? (
                      <button type="button" onClick={() => visit(place)}>
                        {name}
                      </button>
                    ) : (
                      <span>{name}</span>
                    )}
                  </Fragment>
                );
              })}
            </span>
          </div>
        );
      })}
    </div>
  );
}

/** Help's copy, opened with showWhichOne(). Mounted once beside the tour; closes when a place is picked. */
export function WhichOneSheet() {
  const t = useT();
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const show = () => setShown(true);
    window.addEventListener(SHOW_WHICH_ONE_EVENT, show);
    return () => window.removeEventListener(SHOW_WHICH_ONE_EVENT, show);
  }, []);
  if (!shown) return null;
  const close = () => setShown(false);
  return (
    <Modal title={t("whichOne.title")} icon={WhichOneIcon} onClose={close} wide>
      <p className="muted" style={{ margin: 0 }}>
        {t("whichOne.lead")}
      </p>
      <WhichOne onGo={close} />
    </Modal>
  );
}
