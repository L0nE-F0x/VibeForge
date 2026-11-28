import { useCallback, useMemo, useState } from "react";
import type { ReviewFile } from "../shared/api.js";

// Which files of a copy go in on Apply. A task's sheet, a run's Changes tab and Viby's copy sheet
// share it, so each ticks, unticks and sends the same way. The list comes from the main process
// (src/core/worktrees.ts copyReview), paired into renames the way Apply pairs them.

/** The review screen's file ticks (see DiffReview). */
export interface DiffSelection {
  picked: ReadonlySet<string>;
  /** Files an earlier Apply brought in, unchanged since: shown as applied, and unticked at first. */
  applied: ReadonlySet<string>;
  onToggle: (path: string) => void;
  onPickAll: () => void;
  onPickNone: () => void;
}

export interface CopyPick {
  /** For DiffReview; undefined while there is no list. */
  selection: DiffSelection | undefined;
  /**
   * What Apply leaves out: every unticked file, both names of a rename. Undefined while there is no
   * list, so Apply leaves out only what was applied before.
   */
  skip: string[] | undefined;
  picked: number;
  total: number;
  /** Something unticked that wasn't applied before: Apply leaves it in the copy, and the copy stays. */
  partial: boolean;
  /** Nothing ticked: Apply would bring nothing in. */
  none: boolean;
}

const NO_FILES: ReviewFile[] = [];

const appliedOf = (files: readonly ReviewFile[]) => new Set(files.filter((file) => file.applied).map((file) => file.path));

export function useCopyPick(files: readonly ReviewFile[] | null | undefined): CopyPick {
  const list = files ?? NO_FILES;
  const [state, setState] = useState(() => ({ files: list, unticked: appliedOf(list) as ReadonlySet<string> }));
  // A new list (another copy, or the same one after an Apply) starts again: what was applied unticked.
  let current = state;
  if (state.files !== list) {
    current = { files: list, unticked: appliedOf(list) };
    setState(current);
  }
  const { unticked } = current;

  const onToggle = useCallback(
    (path: string) =>
      setState((prev) => {
        const next = new Set(prev.unticked);
        if (next.has(path)) next.delete(path);
        else next.add(path);
        return { ...prev, unticked: next };
      }),
    [],
  );
  // Select all ticks what hasn't been applied yet; an applied file is ticked again only by hand.
  const onPickAll = useCallback(() => setState((prev) => ({ ...prev, unticked: new Set([...prev.unticked].filter((path) => prev.files.some((file) => file.applied && file.path === path))) })), []);
  const onPickNone = useCallback(() => setState((prev) => ({ ...prev, unticked: new Set(prev.files.map((file) => file.path)) })), []);

  const applied = useMemo(() => appliedOf(list), [list]);
  const picked = useMemo(() => new Set(list.filter((file) => !unticked.has(file.path)).map((file) => file.path)), [list, unticked]);
  const selection = useMemo(() => (files && list.length ? { picked, applied, onToggle, onPickAll, onPickNone } : undefined), [files, list, picked, applied, onToggle, onPickAll, onPickNone]);
  const skip = useMemo(() => (files ? list.filter((file) => unticked.has(file.path)).flatMap((file) => (file.oldPath ? [file.oldPath, file.path] : [file.path])) : undefined), [files, list, unticked]);
  return {
    selection,
    skip,
    picked: picked.size,
    total: list.length,
    partial: list.some((file) => unticked.has(file.path) && !file.applied),
    none: list.length > 0 && picked.size === 0,
  };
}
