import type { MouseEvent } from "react";
import type { Project } from "@vibeforge/shared";
import { useStore } from "../store.ts";
import { Icon } from "./Icon.tsx";

const CHIP: Record<string, { label: string; cls: string }> = {
  idea: { label: "New", cls: "" },
  specing: { label: "Drafting…", cls: "busy" },
  spec: { label: "Spec ready", cls: "spec" },
  exported: { label: "Exported", cls: "good" },
  error: { label: "Error", cls: "bad" },
};

export function IdeaCard({ p }: { p: Project }) {
  const selectedId = useStore((s) => s.selectedId);
  const select = useStore((s) => s.select);
  const genSpec = useStore((s) => s.genSpec);
  const discard = useStore((s) => s.discard);

  const chip = CHIP[p.status] ?? CHIP.idea;
  const stop = (e: MouseEvent) => e.stopPropagation();

  return (
    <div
      className={"icard" + (selectedId === p.id ? " active" : "") + (p.status === "error" ? " err" : "")}
      onClick={() => select(p.id)}
    >
      <div className="icard-top">
        <span className="icard-title">{p.title}</span>
        <span className={"amb " + p.ambition} title={"Scope: " + p.ambition}>{p.ambition}</span>
      </div>
      {p.pitch && <div className="icard-pitch">{p.pitch}</div>}
      <div className="icard-meta">
        <span className={"chip " + chip.cls}>{chip.label}</span>
        {p.tags?.slice(0, 2).map((t) => <span className="tag" key={t}>{t}</span>)}
        {(p.sources?.length ?? 0) > 0 && (
          <span className="srcdot" title={`Informed by ${p.sources!.length} live source(s)`}><Icon name="globe" size={11} /></span>
        )}
        <span className="spacer" />
        {p.status === "idea" && (
          <button className="btn sm steel" title="Generate a build-ready spec for this idea" onClick={(e) => { stop(e); void genSpec(p.id); }}>
            <Icon name="file-text" size={12} />Create Spec
          </button>
        )}
        <button className="btn sm icon danger" title="Discard" onClick={(e) => { stop(e); discard(p.id); }}>
          <Icon name="trash" size={13} />
        </button>
      </div>
      {p.status === "specing" && <div className="progress"><i /></div>}
    </div>
  );
}
