import { Check, Copy, RefreshCw, X } from "lucide-react";
import { useEffect, useState } from "react";
import { type ComputerItem, type ComputerPart, installLine } from "../../shared/computer.js";
import { tildify } from "../../shared/text.js";
import { call, useAppInfo, useQuery } from "../api.js";
import { useT, type Key } from "../i18n/index.js";
import { useToast } from "../state.js";
import { Button, Skeleton } from "./ui.js";

// Settings → This computer: each part VibeForge uses, found or not. A missing one says what that
// switches off, and the line that installs it here when there is one. Looked for when the card
// opens and on Check again, never in the background.

const LABEL: Partial<Record<ComputerPart, Key>> = {
  speech: "first.computer.label.speech",
  tray: "first.computer.label.tray",
  desktop: "first.computer.label.desktop",
};

export function ComputerCard() {
  const t = useT();
  const home = useAppInfo().data?.home ?? "";
  const query = useQuery("computer", [], () => call("app.computer"), { poll: false });
  const [checking, setChecking] = useState(false);
  const facts = query.data;
  // Settings opened again: look again, as the card says, instead of showing the last look.
  useEffect(() => {
    if (query.data) void query.reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const again = async () => {
    setChecking(true);
    try {
      await query.reload();
    } finally {
      setChecking(false);
    }
  };
  return (
    <div className="card vstack computer-card" style={{ gap: 10 }}>
      <div className="hstack">
        <span className="faint grow">{t("first.computer.lead")}</span>
        <Button size="sm" icon={RefreshCw} busy={checking} onClick={() => void again()}>
          {t("first.computer.check")}
        </Button>
      </div>
      {!facts ? (
        query.error ? <span className="faint">{t("first.computer.failed")}</span> : <Skeleton rows={4} />
      ) : (
        <>
          <div className="computer-group">{t("first.computer.clis")}</div>
          {facts.clis.length ? (
            facts.clis.map((item) => <Row key={item.id} item={item} label={item.name} home={home} />)
          ) : (
            <div className="computer-row missing">
              <X size={14} className="computer-mark" />
              <span>{t("first.computer.noCli")}</span>
            </div>
          )}
          <div className="computer-group">{t("first.computer.parts")}</div>
          {facts.parts.map((item) => {
            const part = item.id as ComputerPart;
            const label = LABEL[part] ? t(LABEL[part]) : item.name;
            const off = !item.found ? t(`first.computer.off.${part}` as Key) : part === "desktop" && item.name !== "Hyprland" ? t("first.computer.notHyprland") : null;
            return (
              <Row key={item.id} item={item} label={label} home={home} detail={part === "desktop" && item.found ? item.name : part === "speech" && item.found ? item.name : null}>
                {off && <span className="computer-off">{off}</span>}
                {!item.found && <InstallLine line={installLine(part, facts.packageManager)} />}
              </Row>
            );
          })}
        </>
      )}
    </div>
  );
}

function Row({ item, label, home, detail, children }: { item: ComputerItem; label: string; home: string; detail?: string | null; children?: React.ReactNode }) {
  const t = useT();
  const shown = item.found ? [detail, item.version, item.path ? tildify(item.path, home) : null].filter(Boolean).join(" · ") || t("first.computer.found") : t("first.computer.missing");
  return (
    <div className={`computer-row${item.found ? "" : " missing"}`}>
      {item.found ? <Check size={14} className="computer-mark ok" /> : <X size={14} className="computer-mark" />}
      <div className="vstack grow" style={{ gap: 3, minWidth: 0 }}>
        <div className="hstack" style={{ gap: 10, minWidth: 0 }}>
          <span className="computer-name">{label}</span>
          <span className="faint mono truncate">{shown}</span>
        </div>
        {children}
      </div>
    </div>
  );
}

function InstallLine({ line }: { line: string | null }) {
  const t = useT();
  const { push } = useToast();
  if (!line) return null;
  return (
    <div className="hstack computer-install" style={{ gap: 6 }}>
      <code className="selectable mono">{line}</code>
      <Button
        size="sm"
        variant="ghost"
        icon={Copy}
        tip={t("common.copy")}
        onClick={() => void call("app.copyText", line).then(() => push("success", t("first.computer.copied")))}
      />
    </div>
  );
}
