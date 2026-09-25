import { BookOpen, Bug, Compass, Globe, Keyboard, Lightbulb, ScrollText } from "lucide-react";
import type { AppInfo, Engine } from "../../shared/api.js";
import { call, useAppInfo, useEngines } from "../api.js";
import { startTour } from "./Tour.js";
import { Menu, Modal, Popover } from "./ui.js";

// Help lives in the rail: the tour, the shortcut sheet, and a way to reach the project.
// Bug reports and ideas open a GitHub issue form with the version details filled in; nothing
// is sent from the app itself.

export const REPO = "https://github.com/L0nE-F0x/VibeForge";
export const SITE = "https://vibeforgeapp.netlify.app";
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

function open(url: string): void {
  void call("app.openExternal", url);
}

export function HelpPopover({ anchor, onClose }: { anchor: HTMLElement; onClose: () => void }) {
  const info = useAppInfo().data;
  const engines = useEngines().data ?? [];
  const repo = info?.repo ?? REPO;
  return (
    <Popover anchor={anchor} onClose={onClose}>
      <div className="list-label" style={{ paddingTop: 6 }}>
        Help
      </div>
      <Menu
        onClose={onClose}
        items={[
          { label: "Take the tour", icon: Compass, onSelect: startTour },
          { label: "Keyboard shortcuts", icon: Keyboard, hint: "Ctrl+Shift+/", onSelect: () => window.dispatchEvent(new Event(SHOW_SHORTCUTS_EVENT)) },
          "sep",
          { label: "Suggest a feature", icon: Lightbulb, onSelect: () => open(issueUrl("feature", info, engines)) },
          { label: "Report a bug", icon: Bug, onSelect: () => open(issueUrl("bug", info, engines)) },
          "sep",
          { label: "Documentation", icon: BookOpen, onSelect: () => open(`${repo}#readme`) },
          { label: "What's new", icon: ScrollText, onSelect: () => open(`${repo}/commits/main`) },
          { label: "Website", icon: Globe, onSelect: () => open(SITE) },
        ]}
      />
      <div className="help-foot">
        VibeForge {info?.version ?? ""} · MIT · no telemetry
      </div>
    </Popover>
  );
}

const GESTURES = new Set(["Double-click", "Drag", "Drop a file"]);

const SHORTCUTS: Array<{ group: string; keys: Array<[string, string]> }> = [
  {
    group: "Anywhere",
    keys: [
      ["Ctrl+1…8", "Switch views"],
      ["Ctrl+,", "Settings"],
      ["Alt+←", "Go back"],
      ["Ctrl+Shift+B", "Collapse or expand the side panel"],
      ["Ctrl+Shift+/", "This list"],
      ["Esc", "Close a dialog or menu"],
    ],
  },
  {
    group: "Code",
    keys: [
      ["Ctrl+Shift+M", "Maximize or restore the focused pane"],
      ["Double-click", "Maximize a pane from its title bar"],
      ["Drag", "Move a pane by its title bar"],
      ["Enter", "Launch from the bar at the bottom"],
    ],
  },
  {
    group: "Terminals",
    keys: [
      ["Ctrl+Shift+C", "Copy the selection"],
      ["Ctrl+Shift+V", "Paste"],
      ["Ctrl+V", "Sent to the program, as in any terminal"],
      ["Drop a file", "Insert its path"],
    ],
  },
  {
    group: "Editing",
    keys: [
      ["Ctrl+S", "Save an agent, skill, task or routine"],
      ["Ctrl+Shift+I", "Developer tools"],
    ],
  },
];

export function ShortcutsModal({ onClose }: { onClose: () => void }) {
  return (
    <Modal title="Keyboard shortcuts" icon={Keyboard} onClose={onClose} wide>
      <div className="shortcut-grid">
        {SHORTCUTS.map((section) => (
          <section key={section.group}>
            <div className="list-label">{section.group}</div>
            {section.keys.map(([keys, text]) => (
              <div key={keys} className="shortcut-row">
                <span className="grow">{text}</span>
                <span className="tour-caps">
                  {GESTURES.has(keys) ? <span className="faint">{keys}</span> : keys.split("+").map((key) => <kbd key={key}>{key}</kbd>)}
                </span>
              </div>
            ))}
          </section>
        ))}
      </div>
    </Modal>
  );
}
