import { BookOpen, Bug, Compass, Download, Globe, Keyboard, Lightbulb, RefreshCw, ScrollText, Stethoscope } from "lucide-react";
import type { AppInfo, Engine, Settings } from "../../shared/api.js";
import { call, useAppInfo, useEngines, useSettings, useUpdate } from "../api.js";
import { useT, type Key } from "../i18n/index.js";
import { useToast } from "../state.js";
import { tipProps } from "./Tooltip.js";
import { startTour } from "./Tour.js";
import { showUpdate } from "./Update.js";
import { Menu, Modal, Popover, type MenuItem } from "./ui.js";

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

export function issueUrl(kind: "bug" | "feature", info: AppInfo | undefined, engines: Engine[]): string {
  const params = new URLSearchParams();
  if (kind === "bug") {
    params.set("template", "bug_report.yml");
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
  const items: Array<MenuItem | "sep"> = [
    ...(waiting ? ([{ label: t("help.updateTo", { version: waiting }), icon: Download, accent: true, onSelect: showUpdate }, "sep"] as Array<MenuItem | "sep">) : []),
    { label: t("help.tour"), icon: Compass, onSelect: startTour },
    { label: t("help.shortcuts"), icon: Keyboard, hint: "Ctrl+Shift+/", onSelect: () => window.dispatchEvent(new Event(SHOW_SHORTCUTS_EVENT)) },
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
  text: Key;
}

const SHORTCUTS: Array<{ group: Key; rows: ShortcutRow[] }> = [
  {
    group: "shortcuts.anywhere",
    rows: [
      { keys: "Ctrl+1…8", text: "shortcuts.switchViews" },
      { keys: "Ctrl+,", text: "shortcuts.settings" },
      { keys: "Alt+←", text: "shortcuts.back" },
      { keys: "Ctrl+Shift+B", text: "shortcuts.panel" },
      { keys: "Ctrl+Shift+/", text: "shortcuts.list" },
      { keys: "Esc", text: "shortcuts.closeDialog" },
    ],
  },
  {
    group: "shortcuts.code",
    rows: [
      { keys: "Ctrl+Shift+M", text: "shortcuts.maximize" },
      { gesture: "shortcuts.doubleClick", text: "shortcuts.maximizeTitle" },
      { gesture: "shortcuts.drag", text: "shortcuts.movePane" },
      { keys: "Enter", text: "shortcuts.launch" },
    ],
  },
  {
    group: "shortcuts.terminals",
    rows: [
      { keys: "Ctrl+Shift+C", text: "shortcuts.copy" },
      { keys: "Ctrl+Shift+V", text: "shortcuts.paste" },
      { keys: "Ctrl+V", text: "shortcuts.ctrlV" },
      { gesture: "shortcuts.dropFile", text: "shortcuts.drop" },
    ],
  },
  {
    group: "shortcuts.voice",
    rows: [
      { keys: "Ctrl+Shift+Space", text: "shortcuts.dictate" },
      { keys: "Ctrl+Alt+Space", text: "shortcuts.converse" },
      { keys: "Esc", text: "shortcuts.dictateCancel" },
    ],
  },
  {
    group: "shortcuts.editing",
    rows: [
      { keys: "Ctrl+S", text: "shortcuts.save" },
      { keys: "Ctrl+Shift+I", text: "shortcuts.devtools" },
    ],
  },
];

export function ShortcutsModal({ onClose }: { onClose: () => void }) {
  const t = useT();
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
                  {row.gesture ? <span className="faint">{t(row.gesture)}</span> : row.keys?.split("+").map((key) => <kbd key={key}>{key}</kbd>)}
                </span>
              </div>
            ))}
          </section>
        ))}
      </div>
    </Modal>
  );
}
