import { Copy, Plus } from "lucide-react";
import { useEffect, useState } from "react";
import type { Workspace, WorkspaceCopySetup } from "../../../shared/api.js";
import { cleanCopyFolderPath, DEFAULT_COPY_FILES } from "../../../shared/copy-setup.js";
import { call, errorText } from "../../api.js";
import { Button, Field, Input, Modal, Notice, TextArea, Toggle } from "../../components/ui.js";
import { useT } from "../../i18n/index.js";
import { useAction } from "../../state.js";

const DEFAULT_FILES_TEXT = DEFAULT_COPY_FILES.join("\n");

function parseLines(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith("#") || out.includes(trimmed)) continue;
    out.push(trimmed);
  }
  return out;
}

/** Per-workspace settings for what comes along when a separate copy is made, and an optional setup command. */
export function CopySetupDialog({ workspace, onClose }: { workspace: Workspace; onClose: () => void }) {
  const t = useT();
  const [filesText, setFilesText] = useState(() => (workspace.copySetup?.files ?? DEFAULT_COPY_FILES).join("\n"));
  const [foldersText, setFoldersText] = useState(() => (workspace.copySetup?.folders ?? []).join("\n"));
  const [setupCommand, setSetupCommand] = useState(() => workspace.copySetup?.setupCommand ?? "");
  const [useInclude, setUseInclude] = useState(() => workspace.copySetup?.worktreeInclude !== false);
  const [folderError, setFolderError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [hasNodeModules, setHasNodeModules] = useState(false);
  const [hasWorktreeInclude, setHasWorktreeInclude] = useState(false);

  useEffect(() => {
    setFilesText((workspace.copySetup?.files ?? DEFAULT_COPY_FILES).join("\n"));
    setFoldersText((workspace.copySetup?.folders ?? []).join("\n"));
    setSetupCommand(workspace.copySetup?.setupCommand ?? "");
    setUseInclude(workspace.copySetup?.worktreeInclude !== false);
    setFolderError(null);
    setSaveError(null);
    let cancelled = false;
    void Promise.all([
      call("app.pathExists", `${workspace.path}/node_modules`).catch(() => false),
      call("app.pathExists", `${workspace.path}/.worktreeinclude`).catch(() => false),
    ]).then(([nm, wi]) => {
      if (cancelled) return;
      setHasNodeModules(Boolean(nm));
      setHasWorktreeInclude(Boolean(wi));
    });
    return () => {
      cancelled = true;
    };
  }, [workspace.id, workspace.path, workspace.copySetup]);

  const currentFolders = parseLines(foldersText).map((line) => cleanCopyFolderPath(line) ?? line);
  const showNodeModulesHint = hasNodeModules && !currentFolders.includes("node_modules");
  const isDefault = filesText.trim() === DEFAULT_FILES_TEXT && !foldersText.trim() && !setupCommand.trim() && useInclude;

  const [save, saving] = useAction(async () => {
    setFolderError(null);
    setSaveError(null);
    const files = parseLines(filesText);
    const folders = parseLines(foldersText);
    const cleanFolders = folders.map(cleanCopyFolderPath);
    if (cleanFolders.some((folder) => folder === null)) {
      setFolderError(t("copySetup.folderInvalid"));
      return;
    }
    const command = setupCommand.trim();
    const isFilesDefault = files.join("\n") === DEFAULT_FILES_TEXT;
    const copySetup: WorkspaceCopySetup | null =
      isFilesDefault && !cleanFolders.length && !command && useInclude
        ? null
        : {
            ...(isFilesDefault ? {} : { files }),
            ...(cleanFolders.length ? { folders: cleanFolders.filter((folder): folder is string => folder !== null) } : {}),
            ...(command ? { setupCommand: command } : {}),
            ...(useInclude ? {} : { worktreeInclude: false as const }),
          };
    try {
      await call("workspaces.update", workspace.id, { copySetup });
      onClose();
    } catch (err: unknown) {
      setSaveError(errorText(err));
      throw err;
    }
  }, t("common.saveFailed"));

  const addNodeModules = () => {
    const next = [...parseLines(foldersText).map((line) => cleanCopyFolderPath(line) ?? line), "node_modules"];
    setFoldersText(next.join("\n"));
    setFolderError(null);
  };

  const resetDefaults = () => {
    setFilesText(DEFAULT_FILES_TEXT);
    setFoldersText("");
    setSetupCommand("");
    setUseInclude(true);
    setFolderError(null);
    setSaveError(null);
  };

  return (
    <Modal
      title={t("copySetup.title")}
      icon={Copy}
      onClose={onClose}
      footer={
        <>
          {!isDefault && (
            <Button variant="ghost" onClick={resetDefaults} style={{ marginRight: "auto" }}>
              {t("copySetup.reset")}
            </Button>
          )}
          <Button variant="ghost" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button variant="primary" busy={saving} onClick={() => void save()}>
            {t("common.save")}
          </Button>
        </>
      }
    >
      <p className="faint" style={{ margin: 0 }}>
        {workspace.name}
      </p>
      {saveError && <Notice tone="bad">{saveError}</Notice>}
      <Field label={t("copySetup.filesLabel")} hint={t("copySetup.filesHint")}>
        <TextArea
          code
          rows={3}
          value={filesText}
          placeholder={t("copySetup.filesPlaceholder")}
          onChange={(event) => setFilesText(event.target.value)}
        />
      </Field>
      {(hasWorktreeInclude || !useInclude) && <Toggle checked={useInclude} onChange={setUseInclude} label={t("copySetup.worktreeInclude")} />}
      <Field label={t("copySetup.foldersLabel")} hint={t("copySetup.foldersHint")} error={folderError ?? undefined}>
        <TextArea
          code
          rows={2}
          invalid={Boolean(folderError)}
          value={foldersText}
          placeholder={t("copySetup.foldersPlaceholder")}
          onChange={(event) => {
            setFoldersText(event.target.value);
            if (folderError) setFolderError(null);
          }}
        />
      </Field>
      {showNodeModulesHint && (
        <div className="hstack">
          <Button size="sm" icon={Plus} onClick={addNodeModules}>
            {t("copySetup.suggestNodeModules")}
          </Button>
        </div>
      )}
      <Field label={t("copySetup.commandLabel")} hint={t("copySetup.commandHint")}>
        <Input
          className="mono"
          value={setupCommand}
          placeholder={t("copySetup.commandPlaceholder")}
          onChange={(event) => setSetupCommand(event.target.value)}
        />
      </Field>
    </Modal>
  );
}
