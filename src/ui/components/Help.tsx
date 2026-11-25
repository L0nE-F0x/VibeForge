import { BookOpen, Bug, Compass, Download, Globe, Keyboard, Lightbulb, Map as MapIcon, RefreshCw, ScrollText, Stethoscope } from "lucide-react";
import { useCallback, useRef } from "react";
import type { AppInfo, Engine, Settings } from "../../shared/api.js";
import type { DictateButton } from "../../shared/dictation.js";
import { call, useAppInfo, useEngines, useSettings, useUpdate } from "../api.js";
import { useT, type Key } from "../i18n/index.js";
import { shortcutKeys, shortcutSheet } from "../shortcuts.js";
import { useToast } from "../state.js";
import { tipProps } from "./Tooltip.js";
import { startTour } from "./Tour.js";
import { showUpdate } from "./Update.js";
import { useUpdated } from "../update-state.js";
import { showWhichOne, WhichOneIcon } from "./WhichOne.js";
import { Button, Menu, Modal, Popover, type MenuItem } from "./ui.js";

// Help lives in the rail: the tour, the shortcut sheet, updates, and a way to reach the project.
// Bug reports and ideas open a GitHub issue form with the version details filled in; nothing
// is sent from the app itself.

export const REPO = "https://github.com/L0nE-F0x/VibeForge";
export const SITE = "https://vibe-forge.net";
export const APEXFORGE = "https://ame-apexforge.org/";
export const SHOW_SHORTCUTS_EVENT = "vibeforge:shortcuts";

export function environmentText(info: AppInfo | undefined, engines: Engine[]): string {
  const found = engines.filter((engine) => engine.available).map((engine) => engine.label);
  return [
    `VibeForge ${info?.version ?? "?"}`,
    `System: ${info?.os ?? "?"}`,
    `Electron ${info?.electron ?? "?"} · Chromium ${info?.chrome ?? "?"} · Node ${info?.node ?? "?"}`,
    `CLIs on PATH: ${found.length ? found.join(", ") : "none"}`,
  ].join("\n");
}

/** The bug form on GitHub, or the idea form; `happened` fills in the bug form's first field (what the window said). */
export function issueUrl(kind: "bug" | "feature", info: AppInfo | undefined, engines: Engine[], happened?: string): string {
  const params = new URLSearchParams();
  if (kind === "bug") {
    params.set("template", "bug_report.yml");
    if (happened) params.set("what-happened", `VibeForge showed:\n\n${happened}\n\nWhat I was doing:\n`);
    params.set("version", info?.version ?? "");
    params.set("environment", environmentText(info, engines));
  } else {
    params.set("template", "feature_request.yml");
  }
  return `${info?.repo ?? REPO}/issues/new?${params.toString()}`;
}

/** Versions, a few settings and the end of VibeForge's own log, in English for the bug report. */
export async function diagnosticsText(info: AppInfo | undefined, engines: Engine[], settings: Settings | undefined): Promise<string> {
  const lines = await call("app.logTail", 200);
  return [
    "VibeForge diagnostics",
    "",
    environmentText(info, engines),
    `Install: ${info?.install ?? "?"} copy at ${info?.appPath ?? "?"}`,
    settings
      ? `Settings: theme ${settings.theme}, language ${settings.language}, shell ${settings.defaultShell}, default engine ${settings.defaultEngine}, update checks ${settings.checkUpdates ? "on" : "off"}`
      : "Settings: not loaded",
    "",
    `Last ${lines.length} log lines (${info?.logFile ?? "?"}):`,
    "```",
    ...lines,
    "```",
  ].join("\n");
}

/** Copies the diagnostics to the clipboard and says so. */
export function useCopyDiagnostics(): () => Promise<void> {
  const t = useT();
  const info = useAppInfo().data;
  const engines = useEngines().data ?? [];
  const settings = useSettings().data;
  const { push, fail } = useToast();
  return async () => {
    try {
      await call("app.copyText", await diagnosticsText(info, engines, settings));
      push("success", t("diagnostics.copied"), t("diagnostics.copiedBody"));
    } catch (error) {
      fail(error);
    }
  };
}

function open(url: string): void {
  void call("app.openExternal", url);
}

/**
 * A problem in the window, as a notice that stays until closed and says what to do next: copy the
 * diagnostics, then report a bug with them. Nothing is sent from the app; the form opens in the browser.
 */
export function useProblemNotice(): (title: string, detail: string) => void {
  const t = useT();
  const info = useAppInfo().data;
  const engines = useEngines().data ?? [];
  const settings = useSettings().data;
  const { push, fail } = useToast();
  // Read when a button is pressed, so a notice raised before the app info loaded still copies it.
  const latest = useRef({ t, info, engines, settings });
  latest.current = { t, info, engines, settings };
  return useCallback(
    (title: string, detail: string) => {
      const words = latest.current.t;
      push("error", title, detail, undefined, {
        stay: true,
        note: words("first.problem.note"),
        more: [
          {
            label: words("diagnostics.copy"),
            run: () => {
              const now = latest.current;
              void diagnosticsText(now.info, now.engines, now.settings)
                .then((text) => call("app.copyText", text))
                .then(() => push("success", now.t("diagnostics.copied"), now.t("diagnostics.copiedBody")), (error: unknown) => fail(error));
            },
          },
          { label: words("help.bug"), run: () => open(issueUrl("bug", latest.current.info, latest.current.engines, detail ? `${title}\n${detail}` : title)) },
        ],
      });
    },
    [push, fail],
  );
}

/** The same two ways forward, as buttons: under a view that hit a problem. */
export function ProblemActions({ detail }: { detail: string }) {
  const t = useT();
  const info = useAppInfo().data;
  const engines = useEngines().data ?? [];
  const copyDiagnostics = useCopyDiagnostics();
  return (
    <>
      <Button icon={Stethoscope} onClick={() => void copyDiagnostics()}>
        {t("diagnostics.copy")}
      </Button>
      <Button icon={Bug} onClick={() => open(issueUrl("bug", info, engines, `${t("crash.title")}\n${detail}`))}>
        {t("help.bug")}
      </Button>
    </>
  );
}

/** "Created by ApexForge", linking to the ApexForge site in the browser. */
export function Credit({ onOpen }: { onOpen?: () => void }) {
  const t = useT();
  const [before, after = ""] = t("credit.createdBy").split("{name}");
  return (
    <span className="credit">
      {before}
      <a
        href={APEXFORGE}
        {...tipProps("ame-apexforge.org", { side: "top" })}
        onClick={(event) => {
          event.preventDefault();
          onOpen?.();
          open(APEXFORGE);
        }}
      >
        ApexForge
      </a>
      {after}
    </span>
  );
}

export function HelpPopover({ anchor, onClose }: { anchor: HTMLElement; onClose: () => void }) {
  const t = useT();
  const info = useAppInfo().data;
  const engines = useEngines().data ?? [];
  const update = useUpdate().data;
  const copyDiagnostics = useCopyDiagnostics();
  const repo = info?.repo ?? REPO;
  const waiting = update?.available && update.latest ? update.latest.version : null;
  // Already updated on disk this session: what's left is a restart, which the update dialog offers.
  const updated = useUpdated();
  const items: Array<MenuItem | "sep"> = [
    ...(waiting ? ([{ label: updated ? t("updates.finishTitle") : t("help.updateTo", { version: waiting }), icon: Download, accent: true, onSelect: showUpdate }, "sep"] as Array<MenuItem | "sep">) : []),
    { label: t("help.tour"), icon: Compass, onSelect: () => startTour("short") },
    { label: t("first.help.fullTour"), icon: MapIcon, onSelect: () => startTour("full") },
    { label: t("whichOne.title"), icon: WhichOneIcon, onSelect: showWhichOne },
    { label: t("help.shortcuts"), icon: Keyboard, hint: shortcutKeys("app.shortcuts"), onSelect: () => window.dispatchEvent(new Event(SHOW_SHORTCUTS_EVENT)) },
    "sep",
    { label: t("help.feature"), icon: Lightbulb, onSelect: () => open(issueUrl("feature", info, engines)) },
    { label: t("help.bug"), icon: Bug, onSelect: () => open(issueUrl("bug", info, engines)) },
    { label: t("help.diagnostics"), icon: Stethoscope, onSelect: () => void copyDiagnostics() },
    "sep",
    { label: t("help.docs"), icon: BookOpen, onSelect: () => open(`${repo}#readme`) },
    { label: t("help.whatsNew"), icon: ScrollText, onSelect: () => open(`${repo}/releases`) },
    { label: t("help.website"), icon: Globe, onSelect: () => open(SITE) },
    ...(waiting ? [] : [{ label: t("help.checkUpdates"), icon: RefreshCw, onSelect: showUpdate }]),
  ];
  return (
    <Popover anchor={anchor} onClose={onClose}>
      <div className="list-label" style={{ paddingTop: 6 }}>
        {t("help.title")}
      </div>
      <Menu onClose={onClose} items={items} />
      <div className="help-foot">
        <span>{t("help.footer", { version: info?.version ?? "" })}</span>
        <Credit onOpen={onClose} />
      </div>
    </Popover>
  );
}

interface ShortcutRow {
  /** Keys joined with "+", shown as keycaps. */
  keys?: string;
  /** A mouse gesture, shown as words. */
  gesture?: Key;
  /** One of the desk's lights, drawn as it appears. */
  mark?: "waiting" | "working" | "done" | "badge";
  text: Key;
}

const BUTTON_NAMES: Record<Exclude<DictateButton, "off">, Key> = {
  back: "shortcuts.button.back",
  forward: "shortcuts.button.forward",
  middle: "shortcuts.button.middle",
};

/**
 * Every key and gesture comes from the one list the app's key handlers read (shortcuts.ts), with
 * the keys and the mouse button Settings → Voice picked; only the legend of the desk's lights is
 * the sheet's own.
 */
function sheetSections(button: DictateButton): Array<{ group: Key; rows: ShortcutRow[] }> {
  const sections: Array<{ group: Key; rows: ShortcutRow[] }> = shortcutSheet().map((section) => ({
    group: section.group,
    rows: section.rows.flatMap((row): ShortcutRow[] => {
      // A side button that dictates no longer goes back or forward: the other one still does.
      if (row.id === "app.sideButtons" && (button === "back" || button === "forward")) {
        return [button === "back" ? { gesture: BUTTON_NAMES.forward, text: "shortcuts.forward" } : { gesture: BUTTON_NAMES.back, text: "shortcuts.back" }];
      }
      if (row.id === "voice.dictate" && button !== "off") return [row, { gesture: BUTTON_NAMES[button], text: "shortcuts.dictateMouse" }];
      return [row];
    }),
  }));
  return [...sections, LEGEND];
}

const LEGEND: { group: Key; rows: ShortcutRow[] } = {
    group: "shortcuts.marks",
    rows: [
      { mark: "waiting", text: "ws.waiting" },
      { mark: "working", text: "ws.working" },
      { mark: "done", text: "ws.done" },
      { mark: "badge", text: "shortcuts.markBadge" },
    ],
};

export function ShortcutsModal({ onClose }: { onClose: () => void }) {
  const t = useT();
  const SHORTCUTS = sheetSections(useSettings().data?.voice.mouseButton ?? "off");
  return (
    <Modal title={t("shortcuts.title")} icon={Keyboard} onClose={onClose} wide>
      <div className="shortcut-grid">
        {SHORTCUTS.map((section) => (
          <section key={section.group}>
            <div className="list-label">{t(section.group)}</div>
            {section.rows.map((row) => (
              <div key={row.text} className="shortcut-row">
                <span className="grow">{t(row.text)}</span>
                <span className="tour-caps">
                  {row.mark === "badge" ? (
                    <span className="legend-badge">2</span>
                  ) : row.mark ? (
                    <span className={`ws-state ${row.mark}`} aria-hidden />
                  ) : row.gesture ? (
                    <span className="faint">{t(row.gesture)}</span>
                  ) : (
                    row.keys?.split(/\+(?!$)/).map((key) => <kbd key={key}>{key}</kbd>)
                  )}
                </span>
              </div>
            ))}
          </section>
        ))}
      </div>
    </Modal>
  );
}
