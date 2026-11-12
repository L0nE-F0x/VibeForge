import { ChevronDown, ChevronRight, Copy, ExternalLink, File, Folder, FolderOpen, Link2, RefreshCw } from "lucide-react";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { FileNode } from "../../../shared/api.js";
import { tildify } from "../../../shared/text.js";
import { call, useAppInfo } from "../../api.js";
import { PATH_MIME } from "../../components/Terminal.js";
import { tipProps } from "../../components/Tooltip.js";
import { Button, Skeleton } from "../../components/ui.js";
import { useT } from "../../i18n/index.js";

/**
 * How long a click on a file waits before it inserts the path: a second click within it is a
 * double-click, which opens the file instead of inserting the path twice.
 */
const DOUBLE_CLICK_MS = 250;

/**
 * Keys in the tree: ↑/↓ move between rows, → opens a folder and ← closes it (or goes up to its
 * folder), Enter inserts a file's path and Shift+Enter (or Ctrl+Enter) opens it with its app.
 */
function treeKeys(event: KeyboardEvent<HTMLDivElement>) {
  const row = (event.target as HTMLElement).closest<HTMLButtonElement>(".tree-row");
  if (!row || event.altKey || event.metaKey) return;
  const rows = [...event.currentTarget.querySelectorAll<HTMLButtonElement>(".tree-row")];
  const at = rows.indexOf(row);
  const folder = row.getAttribute("aria-expanded");
  let next: HTMLButtonElement | undefined;
  if (event.key === "ArrowDown") next = rows[at + 1];
  else if (event.key === "ArrowUp") next = rows[at - 1];
  else if (event.key === "Home") next = rows[0];
  else if (event.key === "End") next = rows[rows.length - 1];
  else if (event.key === "ArrowRight" && folder === "false") {
    row.click();
  } else if (event.key === "ArrowLeft") {
    if (folder === "true") row.click();
    else {
      // Up to the folder this row is in.
      const depth = Number(row.dataset.depth ?? 0);
      next = rows.slice(0, at).reverse().find((item) => Number(item.dataset.depth ?? 0) < depth);
    }
  } else if (event.key === "Enter" && (event.shiftKey || event.ctrlKey) && row.dataset.path && folder === null) {
    void call("app.openPath", row.dataset.path);
  } else return;
  event.preventDefault();
  next?.focus();
  next?.scrollIntoView({ block: "nearest" });
}

function TreeLevel({
  dir,
  depth,
  onInsert,
  refreshKey,
}: {
  dir: string;
  depth: number;
  onInsert: (path: string) => void;
  refreshKey: number;
}) {
  const t = useT();
  const [nodes, setNodes] = useState<FileNode[] | null>(null);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  // A single click's insert, held until a double-click could still come.
  const pending = useRef(0);
  useEffect(() => () => window.clearTimeout(pending.current), []);
  const clickFile = (path: string, clicks: number) => {
    window.clearTimeout(pending.current);
    // Enter (no clicks) inserts at once; a second click of a double-click inserts nothing.
    if (clicks === 0) onInsert(path);
    else if (clicks === 1) pending.current = window.setTimeout(() => onInsert(path), DOUBLE_CLICK_MS);
  };
  useEffect(() => {
    let cancelled = false;
    void call("files.list", dir)
      .then((list) => !cancelled && setNodes(list))
      .catch(() => !cancelled && setNodes([]));
    return () => {
      cancelled = true;
    };
  }, [dir, refreshKey]);
  if (!nodes) return depth === 0 ? <Skeleton rows={5} /> : null;
  if (nodes.length === 0 && depth === 0) return <div className="faint" style={{ padding: 10 }}>{t("files.empty")}</div>;
  return (
    <>
      {nodes.map((node) => {
        const isDir = node.kind === "dir";
        const expanded = Boolean(open[node.path]);
        return (
          <div key={node.path}>
            <button
              type="button"
              className={`tree-row${node.quiet ? " quiet" : ""}`}
              style={{ paddingLeft: 6 + depth * 14 }}
              aria-expanded={isDir ? expanded : undefined}
              data-depth={depth}
              data-path={node.path}
              draggable
              onDragStart={(event) => {
                event.dataTransfer.setData(PATH_MIME, node.path);
                event.dataTransfer.setData("text/plain", node.path);
                event.dataTransfer.effectAllowed = "copy";
              }}
              onClick={(event) => (isDir ? setOpen((prev) => ({ ...prev, [node.path]: !expanded })) : clickFile(node.path, event.detail))}
              onDoubleClick={() => {
                if (isDir) return;
                window.clearTimeout(pending.current);
                void call("app.openPath", node.path);
              }}
              {...tipProps(isDir ? node.name : t("files.insertOpen", { name: node.name }), { side: "left" })}
            >
              {isDir ? (
                expanded ? <ChevronDown size={12} className="faint" /> : <ChevronRight size={12} className="faint" />
              ) : (
                <span style={{ width: 12 }} />
              )}
              {isDir ? (
                expanded ? <FolderOpen size={13} className="accent-text" /> : <Folder size={13} className="accent-text" style={{ opacity: node.quiet ? 0.5 : 1 }} />
              ) : node.kind === "link" ? (
                <Link2 size={13} className="faint" />
              ) : (
                <File size={13} className="faint" />
              )}
              <span className="truncate">{node.name}</span>
              <span className="tree-actions">
                <span
                  role="button"
                  tabIndex={-1}
                  aria-label={t("files.insert")}
                  className="btn ghost sm icon"
                  {...tipProps(t("files.insert"), { side: "top" })}
                  onClick={(event) => {
                    event.stopPropagation();
                    onInsert(node.path);
                  }}
                >
                  <Copy size={11} />
                </span>
                <span
                  role="button"
                  tabIndex={-1}
                  aria-label={t("files.open")}
                  className="btn ghost sm icon"
                  {...tipProps(t("files.open"), { side: "top" })}
                  onClick={(event) => {
                    event.stopPropagation();
                    void call("app.openPath", node.path);
                  }}
                >
                  <ExternalLink size={11} />
                </span>
              </span>
            </button>
            {isDir && expanded && <TreeLevel dir={node.path} depth={depth + 1} onInsert={onInsert} refreshKey={refreshKey} />}
          </div>
        );
      })}
    </>
  );
}

export function FilesPanel({ root, onInsert }: { root: string; onInsert: (path: string) => void }) {
  const t = useT();
  const home = useAppInfo().data?.home ?? "";
  const [refreshKey, setRefreshKey] = useState(0);
  return (
    <>
      <div className="dock-bar">
        <span className="faint truncate grow mono" style={{ fontSize: "var(--fs-xs)" }} {...tipProps(root)}>
          {tildify(root, home)}
        </span>
        <Button size="sm" variant="ghost" icon={RefreshCw} title={t("common.refresh")} onClick={() => setRefreshKey((key) => key + 1)} />
        <Button size="sm" variant="ghost" icon={FolderOpen} title={t("common.openFileManager")} onClick={() => void call("app.openPath", root)} />
      </div>
      <div className="tree" onKeyDown={treeKeys}>
        <TreeLevel key={root} dir={root} depth={0} onInsert={onInsert} refreshKey={refreshKey} />
      </div>
    </>
  );
}
