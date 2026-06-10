import { useEffect, useState } from "react";
import { providerInfo } from "@vibeforge/shared";
import { useStore } from "../store.ts";
import { md } from "../lib/markdown.ts";
import { hostOf } from "../lib/util.ts";
import { specMarkdown, kickoffPrompt, copyText, downloadMarkdown } from "../lib/export.ts";
import { Icon } from "./Icon.tsx";

export function SpecWorkspace() {
  const project = useStore((s) => s.projects.find((p) => p.id === s.selectedId) || null);
  const settings = useStore((s) => s.settings);
  const genSpec = useStore((s) => s.genSpec);
  const refineSpec = useStore((s) => s.refineSpec);
  const undoRefine = useStore((s) => s.undoRefine);
  const saveSpec = useStore((s) => s.saveSpec);
  const markExported = useStore((s) => s.markExported);
  const discard = useStore((s) => s.discard);
  const toast = useStore((s) => s.toast);

  const [mode, setMode] = useState<"preview" | "edit">("preview");
  const [draft, setDraft] = useState("");
  const [feedback, setFeedback] = useState("");

  // Re-seed the editor whenever the selected project or its spec changes.
  useEffect(() => {
    setDraft(project?.spec ?? "");
    setMode("preview");
    setFeedback("");
  }, [project?.id, project?.spec]);

  if (!project) {
    return (
      <main className="ws">
        <div className="hero">
          <div className="anvil big"><Icon name="flame" size={30} /></div>
          <h2>Forge your next app</h2>
          <p>
            Generate a batch of grounded app ideas, pick one, and get a build-ready spec to paste
            into Claude Code, Cursor, Codex — any coding assistant. Add your model's API key in
            Settings to begin.
          </p>
        </div>
      </main>
    );
  }

  const p = project;
  const specProv = providerInfo(settings.specProvider);
  const busy = p.status === "specing";

  const doExport = async (what: "spec" | "kickoff" | "download") => {
    if (what === "download") {
      downloadMarkdown(p);
      toast({ kind: "good", title: "Spec downloaded", body: `${p.slug}-spec.md` });
    } else {
      const ok = await copyText(what === "spec" ? specMarkdown(p) : kickoffPrompt(p));
      toast(ok
        ? { kind: "good", title: what === "spec" ? "Spec copied" : "Kickoff prompt copied", body: "Paste it into your coding assistant." }
        : { kind: "bad", title: "Copy failed", body: "Select and copy manually from Edit mode." });
      if (!ok) return;
    }
    markExported(p.id);
  };

  return (
    <main className="ws">
      <div className="ws-h">
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="ws-title-row">
            <h1 className="ws-title">{p.title}</h1>
            <span className={"amb " + p.ambition}>{p.ambition}</span>
            {p.status === "exported" && <span className="chip good">Exported</span>}
          </div>
          <p className="ws-pitch">{p.pitch}</p>
          <div className="ws-meta">
            {p.lens && <span className="tag">{p.lens}</span>}
            {p.tags?.map((t) => <span className="tag" key={t}>{t}</span>)}
            {p.providerUsed && <span className="faint mono" style={{ fontSize: 11 }}>via {p.providerUsed}</span>}
          </div>
          {(p.sources?.length ?? 0) > 0 && (
            <div className="ws-sources">
              <Icon name="globe" size={12} />
              {p.sources!.map((u) => (
                <a key={u} href={u} target="_blank" rel="noreferrer">{hostOf(u)}</a>
              ))}
            </div>
          )}
        </div>
        <button className="btn danger" onClick={() => discard(p.id)}><Icon name="trash" size={14} />Discard</button>
      </div>

      {p.status === "idea" && (
        <div className="ws-cta">
          <h3>No spec yet</h3>
          <p className="muted">
            Draft a build-ready spec with <b>{specProv.label}</b> — architecture, data model, full
            feature set, and acceptance criteria your coding assistant can run with.
          </p>
          <button className="btn primary" onClick={() => void genSpec(p.id)}>
            <Icon name="file-text" size={15} />Create Spec
          </button>
        </div>
      )}

      {busy && (
        <div className="ws-cta">
          <div className="progress" style={{ width: 220 }}><i /></div>
          <p className="muted" style={{ marginTop: 12 }}>{p.statusMsg || "Working…"}</p>
        </div>
      )}

      {p.status === "error" && (
        <div className="ws-cta">
          <p className="errline" style={{ maxWidth: 520 }}>{p.error}</p>
          <button className="btn" onClick={() => void genSpec(p.id)}><Icon name="refresh" size={14} />Retry</button>
        </div>
      )}

      {(p.status === "spec" || p.status === "exported") && !busy && (
        <>
          <div className="ws-toolbar">
            <div className="seg">
              <button className={mode === "preview" ? "on" : ""} onClick={() => { saveSpec(p.id, draft); setMode("preview"); }}>
                <Icon name="eye" size={13} />Preview
              </button>
              <button className={mode === "edit" ? "on" : ""} onClick={() => setMode("edit")}>
                <Icon name="pencil" size={13} />Edit
              </button>
            </div>
            {p.prevSpec && (
              <button className="btn sm ghost" title="Swap back to the previous version" onClick={() => undoRefine(p.id)}>
                <Icon name="undo" size={13} />Undo refine
              </button>
            )}
            <span className="spacer" />
            <button className="btn sm" onClick={() => void doExport("spec")}><Icon name="copy" size={13} />Copy spec</button>
            <button className="btn sm" onClick={() => void doExport("kickoff")}><Icon name="terminal" size={13} />Copy kickoff prompt</button>
            <button className="btn sm steel" onClick={() => void doExport("download")}><Icon name="download" size={13} />Download .md</button>
          </div>

          <div className="ws-body">
            {mode === "preview"
              ? <div className="markdown specdoc" dangerouslySetInnerHTML={{ __html: md(draft) }} />
              : <textarea
                  className="spec-edit"
                  spellCheck={false}
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onBlur={() => saveSpec(p.id, draft)}
                />}
          </div>

          <div className="ws-refine">
            <input
              className="feedback"
              placeholder={`Ask ${specProv.short} to revise — e.g. "swap React for Svelte, add a CLI companion"…`}
              value={feedback}
              onChange={(e) => setFeedback(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && feedback.trim()) { void refineSpec(p.id, feedback.trim()); setFeedback(""); }
              }}
            />
            <button
              className="btn"
              disabled={!feedback.trim()}
              onClick={() => { void refineSpec(p.id, feedback.trim()); setFeedback(""); }}
            >
              <Icon name="refresh" size={14} />Refine
            </button>
          </div>
        </>
      )}
    </main>
  );
}
