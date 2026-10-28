import { useEffect, useRef } from "react";
import type { ThemeChoice, ThemeList } from "../../shared/api.js";
import { call, on, useQuery } from "../api.js";
import { useT } from "../i18n/index.js";
import { usePalette } from "../theme.js";
import { Field } from "./ui.js";

// Settings → Appearance → Colours: follow the desktop's Omarchy theme, or pin any theme VibeForge
// can wear (the ones installed here and Omarchy's stock themes, which it ships). Picking one, by
// click or arrow key, restyles the app at once.

/** The setting that follows the desktop. */
export const FOLLOW = "omarchy";

/** Every theme, read again when the palette changes (the desktop switched themes). */
export function useThemes(): ThemeList | undefined {
  const themes = useQuery("themes", ["settings"], () => call("app.themes"));
  useEffect(() => on("palette", () => void themes.reload()), [themes.reload]);
  return themes.data;
}

export function ThemeField({ value, onChange }: { value: string; onChange: (theme: string) => void }) {
  const t = useT();
  const palette = usePalette();
  const list = useThemes();
  const pinned = value === FOLLOW ? null : (list?.themes.find((theme) => theme.id === value) ?? null);
  const gone = Boolean(list && value !== FOLLOW && !pinned);
  const hint = pinned
    ? t("settings.coloursPinned", { name: pinned.name })
    : gone
      ? t("settings.coloursGone", { name: value })
      : t("settings.coloursOmarchy", { name: palette?.source === "omarchy" ? palette.name : t("settings.noOmarchyTheme") });
  return (
    <Field label={t("settings.colours")} hint={hint}>
      {list && <ThemePicker list={list} value={pinned ? pinned.id : FOLLOW} onChange={onChange} />}
    </Field>
  );
}

function Squares({ theme }: { theme: ThemeChoice }) {
  return (
    <span className="theme-squares" aria-hidden>
      <i style={{ background: theme.background }} />
      <i style={{ background: theme.accent }} />
      <i style={{ background: theme.accent2 }} />
    </span>
  );
}

function ThemePicker({ list, value, onChange }: { list: ThemeList; value: string; onChange: (theme: string) => void }) {
  const t = useT();
  const group = useRef<HTMLDivElement>(null);
  const ids = [FOLLOW, ...list.themes.map((theme) => theme.id)];
  const apex = list.themes[0];

  // ←/→ step through the list; ↑/↓ move a row of the grid, and the follow choice heads it.
  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const radios = [...(group.current?.querySelectorAll<HTMLElement>('[role="radio"]') ?? [])];
    // From the focused choice, which moves at once; the saved one catches up a moment later.
    const focused = radios.indexOf(document.activeElement as HTMLElement);
    const at = focused >= 0 ? focused : Math.max(0, ids.indexOf(value));
    const top = radios[1]?.offsetTop;
    const columns = Math.max(1, radios.slice(1).filter((radio) => radio.offsetTop === top).length);
    const last = ids.length - 1;
    const to =
      event.key === "ArrowRight"
        ? Math.min(last, at + 1)
        : event.key === "ArrowLeft"
          ? Math.max(0, at - 1)
          : event.key === "ArrowDown"
            ? at === 0
              ? 1
              : Math.min(last, at + columns)
            : event.key === "ArrowUp"
              ? Math.max(0, at - columns)
              : event.key === "Home"
                ? 0
                : event.key === "End"
                  ? last
                  : -1;
    if (to < 0) return;
    event.preventDefault();
    radios[to]?.focus();
    if (to !== at) onChange(ids[to]);
  };

  const radio = (id: string, children: React.ReactNode, className?: string) => (
    <button
      key={id}
      type="button"
      role="radio"
      className={className ? `theme-choice ${className}` : "theme-choice"}
      aria-checked={value === id}
      tabIndex={value === id ? 0 : -1}
      onClick={() => value !== id && onChange(id)}
    >
      {children}
    </button>
  );

  return (
    <div className="theme-picker" role="radiogroup" aria-label={t("settings.colours")} ref={group} onKeyDown={onKeyDown}>
      {radio(
        FOLLOW,
        <>
          <Squares theme={list.system ?? apex} />
          <span className="truncate">{t("settings.followOmarchy")}</span>
          <span className="theme-note truncate">{list.system?.name ?? t("settings.noOmarchyTheme")}</span>
        </>,
        "follow",
      )}
      {list.themes.map((theme) =>
        radio(
          theme.id,
          <>
            <Squares theme={theme} />
            <span className="truncate">{theme.name}</span>
          </>,
        ),
      )}
    </div>
  );
}
