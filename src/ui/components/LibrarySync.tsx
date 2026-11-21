import { FolderPlus, Laptop, RefreshCw, Settings2 } from "lucide-react";
import type { Agent, LibraryItemView } from "../../shared/api.js";
import { call, useQuery, useSync } from "../api.js";
import { Rich } from "../i18n/Rich.js";
import { useT } from "../i18n/index.js";
import { useAction, useNav } from "../state.js";
import { ConflictRow } from "../views/code/SyncDialog.js";
import { Button, Field, Notice, Toggle } from "./ui.js";

// Saved agents and skills syncing with the paired machines: the switch on each, the mark in the
// lists, an agent's folders that aren't on this machine, its stand-in CLI, and texts both machines
// changed. What syncs and how is in src/core/sync/library.ts.

export const useLibrary = () => useQuery("sync.library", ["sync", "agents", "skills"], () => call("sync.library"));

/** Whether a switch can be used: sync running here and a machine paired. */
export function useSyncReady(): { ready: boolean; reason: "off" | "unpaired" | null } {
  const view = useSync().data;
  if (!view?.running) return { ready: false, reason: "off" };
  if (!view.machines.length) return { ready: false, reason: "unpaired" };
  return { ready: true, reason: null };
}

/** The small mark a synced agent or skill has in its list. */
export function SyncMark({ item }: { item: LibraryItemView | undefined }) {
  const t = useT();
  if (!item?.syncing) return null;
  const waiting = item.waiting.length > 0 || item.engine !== null;
  return (
    <span title={t(waiting ? "library.syncsWaiting" : "library.syncs")} style={{ display: "inline-flex", flex: "none", color: waiting ? "var(--yellow)" : "var(--fg-3)" }}>
      <RefreshCw size={12} aria-label={t(waiting ? "library.syncsWaiting" : "library.syncs")} />
    </span>
  );
}

/** The switch on an agent's or skill's page. */
export function SyncSwitch({ kind, id }: { kind: "agent" | "skill"; id: string }) {
  const t = useT();
  const { go } = useNav();
  const { ready, reason } = useSyncReady();
  const library = useLibrary().data;
  const item = kind === "agent" ? library?.agents[id] : library?.skills[id];
  const [set, setting] = useAction(async (on: boolean) => call(kind === "agent" ? "sync.setAgent" : "sync.setSkill", id, on), t("library.setFailed"));
  const carried = kind === "skill" && !item?.on && (item?.via.length ?? 0) > 0;
  const hint = !ready
    ? t(reason === "unpaired" ? "library.needMachine" : "library.needSync")
    : carried
      ? t("library.carried", { agents: item?.via.join(", ") ?? "" })
      : item?.on
        ? t(kind === "agent" ? "library.onAgent" : "library.onSkill")
        : t(kind === "agent" ? "library.offAgent" : "library.offSkill");
  return (
    <div className="card vstack" style={{ gap: 6 }}>
      <Field hint={hint}>
        <div className="hstack" style={{ alignItems: "center" }}>
          <span className="grow">
            <Toggle checked={Boolean(item?.on || carried)} disabled={!ready || setting || carried} onChange={(on) => void set(on)} label={t("library.switch")} />
          </span>
          {!ready && (
            <Button size="sm" variant="ghost" icon={Settings2} onClick={() => go({ view: "settings", section: "sync" })}>
              {t("library.openSettings")}
            </Button>
          )}
        </div>
      </Field>
      {item?.from && (
        <span className="faint hstack" style={{ alignItems: "center", fontSize: "var(--fs-sm)" }}>
          <Laptop size={12} /> {t("library.from", { machine: item.from })}
        </span>
      )}
    </div>
  );
}

/** A synced agent's CLI that isn't installed here, and the one standing in for it. */
export function EngineStandIn({ agentId }: { agentId: string }) {
  const t = useT();
  const engine = useLibrary().data?.agents[agentId]?.engine;
  if (!engine) return null;
  return <Notice tone="warn">{t("library.engineStandIn", { wanted: engine.wanted, using: engine.using })}</Notice>;
}

/** A synced agent's folders that weren't found on this machine: pick one, or wait for the workspace. */
export function WaitingFolders({ agent }: { agent: Agent }) {
  const t = useT();
  const item = useLibrary().data?.agents[agent.id];
  const offers = useSync().data?.offers ?? [];
  const [pick] = useAction(async (key: string) => {
    const folder = await call("app.pickFolder", t("agents.allowIn", { name: agent.name }));
    if (folder) await call("sync.placeFolder", agent.id, key, folder);
  }, t("agents.addFolderFailed"));
  if (!item?.waiting.length) return null;
  return (
    <div className="vstack" style={{ gap: 6 }}>
      <div className="field-label">{t("library.waitingTitle")}</div>
      {item.waiting.map((place) => {
        const offer = place.folderId ? offers.find((row) => row.folderId === place.folderId) : undefined;
        return (
          <div key={place.key} className="card hstack" style={{ padding: "8px 12px", alignItems: "center" }}>
            <span className="grow">
              <Rich text={offer ? t("library.waitingOffer", { name: place.label, machine: offer.machineName }) : t("library.waiting", { name: place.label })} />
            </span>
            <Button size="sm" icon={FolderPlus} onClick={() => void pick(place.key)}>
              {t("library.pickFolder")}
            </Button>
          </div>
        );
      })}
    </div>
  );
}

/** Texts of this agent or skill both machines changed, with the choices for each. */
export function LibraryConflicts({ kind, id }: { kind: "agent" | "skill"; id: string }) {
  const t = useT();
  const conflicts = (useSync().data?.conflicts ?? []).filter((conflict) => conflict.kind === kind && conflict.itemId === id);
  if (!conflicts.length) return null;
  return (
    <div className="vstack" style={{ gap: 8 }}>
      <div className="field-label">{t("sync.conflictsTitle")}</div>
      {conflicts.map((conflict) => (
        <ConflictRow key={conflict.id} conflict={conflict} />
      ))}
    </div>
  );
}
