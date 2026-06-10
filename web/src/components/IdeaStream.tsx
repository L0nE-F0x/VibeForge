import { useStore, matchesFilter } from "../store.ts";
import type { StreamFilter } from "../store.ts";
import { IdeaCard } from "./IdeaCard.tsx";
import { Icon } from "./Icon.tsx";

const FILTERS: { id: StreamFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "new", label: "New" },
  { id: "specs", label: "Specs" },
  { id: "exported", label: "Exported" },
];

export function IdeaStream() {
  const projects = useStore((s) => s.projects);
  const filter = useStore((s) => s.filter);
  const setFilter = useStore((s) => s.setFilter);
  const generating = useStore((s) => s.generating);
  const clearIdeas = useStore((s) => s.clearIdeas);

  const visible = projects.filter((p) => matchesFilter(p, filter));

  return (
    <aside className="stream">
      <div className="stream-h">
        <span className="stream-title">Ideas</span>
        <span className="ct">{visible.length}</span>
        <span className="spacer" />
        <div className="fpills">
          {FILTERS.map((f) => (
            <button key={f.id} className={"fpill" + (filter === f.id ? " on" : "")} onClick={() => setFilter(f.id)}>
              {f.label}
            </button>
          ))}
        </div>
        {projects.length > 0 && (
          <button className="btn sm icon danger" title="Delete all ideas" onClick={() => clearIdeas()}>
            <Icon name="trash" size={13} />
          </button>
        )}
      </div>
      <div className="stream-body">
        {generating && (
          <div className="gen-note"><div className="progress"><i /></div>Inventing new ideas…</div>
        )}
        {visible.length === 0 && !generating && (
          <div className="stream-empty">
            <Icon name="sparkles" size={22} />
            <div>
              {projects.length === 0
                ? <>The studio is cold. Add your API key in <b>Settings</b>, then hit <b>Generate ideas</b> to mint a batch.</>
                : <>Nothing matches this filter.</>}
            </div>
          </div>
        )}
        {visible.map((p) => <IdeaCard key={p.id} p={p} />)}
      </div>
    </aside>
  );
}
