import { ChevronDown, ChevronRight, Copy, ExternalLink, File, Folder, FolderOpen, Link2, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import type { FileNode } from "../../../shared/api.js";
import { tildify } from "../../../shared/text.js";
import { call, useAppInfo } from "../../api.js";
import { PATH_MIME } from "../../components/Terminal.js";
import { tipProps } from "../../components/Tooltip.js";
import { Button, Skeleton } from "../../components/ui.js";
import { useT } from "../../i18n/index.js";

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
              draggable
              onDragStart={(event) => {
                event.dataTransfer.setData(PATH_MIME, node.path);
                event.dataTransfer.setData("text/plain", node.path);
                event.dataTransfer.effectAllowed = "copy";
              }}
              onClick={() => (isDir ? setOpen((prev) => ({ ...prev, [node.path]: !expanded })) : onInsert(node.path))}
              onDoubleClick={() => !isDir && void call("app.openPath", node.path)}
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
      <div className="tree">
        <TreeLevel key={root} dir={root} depth={0} onInsert={onInsert} refreshKey={refreshKey} />
      </div>
    </>
  );
}
