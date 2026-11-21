import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { readJson, writeJson } from "../fsx.js";
import { conflictName, DEFAULT_IGNORES, type ConflictName } from "./protocol.js";

// When a file changes on both machines before they sync, Syncthing keeps the later change in
// place and leaves the other as a "sync-conflict" copy beside it. VibeForge doesn't leave those
// lying in the workspace: each one is moved here, `<data>/sync/conflicts/<id>/`, with a note of
// which file it belongs to, and waits for a choice (keep the other machine's, or put this one's
// back). Answered ones are kept a month longer, so no choice loses a version for good.

/** How long an answered conflict's saved version is kept. */
export const KEEP_ANSWERED_MS = 30 * 24 * 60 * 60 * 1000;

export interface ConflictRecord {
  id: string;
  folderId: string;
  /** The workspace's folder. */
  root: string;
  /** "agent" and "skill": a synced agent's or skill's text changed on both machines (folderId is its sync id, root is ""). */
  kind: "file" | "commits" | "agent" | "skill";
  /** The file, relative to the workspace (always with "/"); for commits, the branch; for an agent or skill, its name. */
  path: string;
  /** For an agent or skill: which text ("memory", "brief" or "body") and its id on this machine. */
  section?: "memory" | "brief" | "body";
  itemId?: string;
  /** For commits: the branch this machine's commits were kept on. */
  savedBranch: string | null;
  /** The start of the id of the machine whose version is in the workspace now. */
  winner: string;
  at: string;
}

export interface FoundCopy {
  /** The copy's full path. */
  file: string;
  name: ConflictName;
}

/** Syncthing's conflict copies directly inside `dir`. */
export function copiesIn(dir: string): FoundCopy[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const found: FoundCopy[] = [];
  for (const name of names) {
    const parsed = conflictName(name);
    if (parsed) found.push({ file: path.join(dir, name), name: parsed });
  }
  return found;
}

/**
 * Every conflict copy under a workspace, for the look VibeForge takes when sync starts (a copy
 * made while it wasn't running). Folders that never sync are skipped, and `.git` has its own
 * handling. Stops after `maxDirs` folders: a huge tree is looked at as its files arrive instead.
 */
export function walkCopies(root: string, maxDirs = 20_000): FoundCopy[] {
  const found: FoundCopy[] = [];
  const queue = [root];
  let seen = 0;
  while (queue.length && seen < maxDirs) {
    const dir = queue.pop() as string;
    seen += 1;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (entry.name === ".git" || entry.name === ".stfolder" || (DEFAULT_IGNORES as readonly string[]).includes(entry.name)) continue;
        queue.push(path.join(dir, entry.name));
        continue;
      }
      const parsed = conflictName(entry.name);
      if (parsed) found.push({ file: path.join(dir, entry.name), name: parsed });
    }
  }
  return found;
}

function sameBytes(a: string, b: string): boolean {
  try {
    const first = fs.statSync(a);
    const second = fs.statSync(b);
    if (!first.isFile() || !second.isFile() || first.size !== second.size) return false;
    return fs.readFileSync(a).equals(fs.readFileSync(b));
  } catch {
    return false;
  }
}

function moveFile(from: string, to: string): void {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  try {
    fs.renameSync(from, to);
  } catch {
    // Another disk: copy, then remove.
    fs.copyFileSync(from, to);
    fs.rmSync(from, { force: true });
  }
}

const SAVED = "mine";

export class ConflictStore {
  constructor(
    private readonly dir: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private folder(id: string): string {
    return path.join(this.dir, id);
  }

  private answered(): string {
    return path.join(this.dir, ".answered");
  }

  /** The ones waiting for a choice, oldest first. */
  list(): ConflictRecord[] {
    let ids: string[];
    try {
      ids = fs.readdirSync(this.dir).filter((name) => !name.startsWith("."));
    } catch {
      return [];
    }
    const records: ConflictRecord[] = [];
    for (const id of ids) {
      const record = readJson<ConflictRecord | null>(path.join(this.folder(id), "meta.json"), null);
      if (record && record.id === id && typeof record.root === "string" && typeof record.path === "string") records.push(record);
    }
    return records.sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
  }

  get(id: string): ConflictRecord | null {
    return this.list().find((record) => record.id === id) ?? null;
  }

  private newId(): string {
    return `${this.now().getTime().toString(36)}-${randomBytes(4).toString("hex")}`;
  }

  /**
   * Takes a conflict copy out of the workspace and keeps it. A copy identical to the file it is a
   * copy of says nothing and is just removed (null). A second copy of a file that already waits
   * moves the earlier unanswered version into `.answered/` first so it stays for 30 days.
   */
  keepFile(folderId: string, root: string, copy: FoundCopy): ConflictRecord | null {
    const original = path.join(path.dirname(copy.file), copy.name.original);
    if (sameBytes(copy.file, original)) {
      fs.rmSync(copy.file, { force: true });
      return null;
    }
    const relative = path.relative(root, original).split(path.sep).join("/");
    const waiting = this.list().find((record) => record.kind === "file" && record.folderId === folderId && record.path === relative);
    // Keep any earlier unanswered conflict in .answered/ instead of overwriting it.
    if (waiting) this.archive(waiting.id);
    const record: ConflictRecord = { id: this.newId(), folderId, root, kind: "file", path: relative, savedBranch: null, winner: copy.name.winner, at: this.now().toISOString() };
    moveFile(copy.file, path.join(this.folder(record.id), SAVED));
    writeJson(path.join(this.folder(record.id), "meta.json"), record);
    return this.get(record.id);
  }

  /** Notes that this machine's commits on `branch` were kept on `savedBranch`. */
  noteCommits(folderId: string, root: string, branch: string, savedBranch: string, winner: string): ConflictRecord {
    const waiting = this.list().find((record) => record.kind === "commits" && record.folderId === folderId && record.savedBranch === savedBranch);
    if (waiting) return waiting;
    const record: ConflictRecord = { id: this.newId(), folderId, root, kind: "commits", path: branch, savedBranch, winner, at: this.now().toISOString() };
    writeJson(path.join(this.folder(record.id), "meta.json"), record);
    return record;
  }

  /**
   * Keeps this machine's version of a synced agent's or skill's text that the other machine's
   * change replaced. A second one for the same text moves the earlier one to the answered ones.
   */
  keepText(item: { kind: "agent" | "skill"; syncId: string; itemId: string; name: string; section: "memory" | "brief" | "body" }, text: string, winner: string): ConflictRecord {
    const waiting = this.list().find((record) => record.kind === item.kind && record.folderId === item.syncId && record.section === item.section);
    if (waiting) this.archive(waiting.id);
    const record: ConflictRecord = { id: this.newId(), folderId: item.syncId, root: "", kind: item.kind, path: item.name, section: item.section, itemId: item.itemId, savedBranch: null, winner, at: this.now().toISOString() };
    fs.mkdirSync(this.folder(record.id), { recursive: true });
    fs.writeFileSync(path.join(this.folder(record.id), SAVED), text);
    writeJson(path.join(this.folder(record.id), "meta.json"), record);
    return record;
  }

  /** This machine's saved text, for an agent or skill conflict. */
  savedText(id: string): string {
    try {
      return fs.readFileSync(this.savedFile(id), "utf8");
    } catch {
      return "";
    }
  }

  /** The saved version's file, for a file conflict. */
  savedFile(id: string): string {
    return path.join(this.folder(id), SAVED);
  }

  /**
   * Answers one. "mine" puts this machine's saved version back over the file (which then syncs to
   * the other machine); "theirs" leaves the file as it is. Either way the record moves to the
   * answered ones. Returns the record, or null when it was gone already.
   */
  resolve(id: string, keep: "mine" | "theirs"): ConflictRecord | null {
    const record = this.get(id);
    if (!record) return null;
    // An agent's or skill's text is put back by the sync desk, which knows where it lives.
    if (record.kind === "file" && keep === "mine") {
      const target = path.join(record.root, ...record.path.split("/"));
      // Inside the workspace only: the record names a path, and a path can be written wrong.
      const inside = path.relative(record.root, target);
      if (!inside || inside.startsWith("..") || path.isAbsolute(inside)) throw new Error("That file is not inside the workspace.");
      // Refuse symlinks at the target or any parent segment inside the workspace so restoring never writes outside it.
      if (fs.lstatSync(record.root).isSymbolicLink()) throw new Error("Refusing to write through a symbolic link.");
      let cursor = record.root;
      const parts = inside.split(path.sep);
      for (let i = 0; i < parts.length; i += 1) {
        cursor = path.join(cursor, parts[i]);
        try {
          const stat = fs.lstatSync(cursor);
          if (stat.isSymbolicLink() || (i === parts.length - 1 && !stat.isFile())) {
            throw new Error("Refusing to write through a symbolic link.");
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          break;
        }
      }
      fs.mkdirSync(path.dirname(target), { recursive: true });
      // What is there now is kept as the answered record's other side, so this choice can be taken back by hand too.
      if (fs.existsSync(target)) fs.copyFileSync(target, path.join(this.folder(id), "theirs"));
      fs.copyFileSync(this.savedFile(id), target);
    }
    this.archive(id);
    return record;
  }

  /** Drops every waiting conflict of a folder that no longer syncs (their saved versions stay a month). */
  forgetFolder(folderId: string): void {
    for (const record of this.list()) if (record.folderId === folderId) this.archive(record.id);
  }

  private archive(id: string): void {
    fs.mkdirSync(this.answered(), { recursive: true });
    const to = path.join(this.answered(), id);
    fs.rmSync(to, { recursive: true, force: true });
    fs.renameSync(this.folder(id), to);
    // Its age counts from the answer.
    const stamp = this.now();
    fs.utimesSync(to, stamp, stamp);
  }

  /** Removes answered conflicts older than a month. */
  tidy(): number {
    let removed = 0;
    let names: string[];
    try {
      names = fs.readdirSync(this.answered());
    } catch {
      return 0;
    }
    for (const name of names) {
      const full = path.join(this.answered(), name);
      try {
        if (this.now().getTime() - fs.statSync(full).mtimeMs > KEEP_ANSWERED_MS) {
          fs.rmSync(full, { recursive: true, force: true });
          removed += 1;
        }
      } catch {
        /* gone already */
      }
    }
    return removed;
  }

  /**
   * What putting this machine's version back would change, as a unified diff: from the file as it
   * is now (the other machine's) to the saved one. "" when git isn't there to make it.
   */
  diff(id: string, currentText?: string): Promise<string> {
    const record = this.get(id);
    if (!record) return Promise.resolve("");
    let current: string;
    if (record.kind === "file") current = path.join(record.root, ...record.path.split("/"));
    else if ((record.kind === "agent" || record.kind === "skill") && currentText !== undefined) {
      // What is in the agent or skill now, beside the saved one, so git can compare the two files.
      current = path.join(this.folder(id), "now");
      fs.writeFileSync(current, currentText);
    } else return Promise.resolve("");
    const from = fs.existsSync(current) ? current : "/dev/null";
    const saved = this.savedFile(id);
    const label = record.kind === "file" ? record.path : `${record.path} (${record.section ?? "text"})`;
    return new Promise((resolve) => {
      execFile(
        "git",
        ["--no-pager", "-c", "color.ui=never", "-c", "core.quotePath=false", "diff", "--no-index", "--no-ext-diff", "--", from, saved],
        { encoding: "utf8", maxBuffer: 4 * 1024 * 1024, timeout: 10_000 },
        (error, stdout) => {
          // 1 only means "they differ".
          const code = (error as { code?: unknown } | null)?.code;
          if (error && code !== 1) return resolve("");
          resolve(relabel(stdout ?? "", from, saved, label));
        },
      );
    });
  }
}

/** The diff with the two temp paths replaced by the workspace's own file name. */
function relabel(diff: string, from: string, saved: string, name: string): string {
  const strip = (file: string) => file.replace(/^\//, "");
  // Only the lines above the first hunk are names; below it a line may begin with the same marks.
  let header = true;
  return diff
    .split("\n")
    .map((line) => {
      if (line.startsWith("@@")) header = false;
      if (!header) return line;
      if (line.startsWith("diff --git ")) return `diff --git a/${name} b/${name}`;
      if (line.startsWith("--- ")) return from === "/dev/null" ? line : `--- a/${name}`;
      if (line.startsWith("+++ ")) return `+++ b/${name}`;
      if (line.startsWith("Binary files ")) return line.replace(`a/${strip(from)}`, `a/${name}`).replace(`b/${strip(saved)}`, `b/${name}`);
      return line;
    })
    .join("\n");
}
