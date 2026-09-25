import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { normalizeEngineRows, planLaunch, resumeArgsFromTranscript, seedEngines, whichBin, withAvailability } from "../../src/core/engines.js";
import { listDir } from "../../src/core/files.js";
import { cwdAllowed, isPathInside } from "../../src/core/places.js";
import { buildPreamble, memoryForPrompt, taskPrompt } from "../../src/core/preamble.js";
import { decideRoutineTick, decideRunNow, describeSchedule, isScheduleValid, mostRecentSlot, nextFireTimes } from "../../src/core/routines.js";
import { allocateRunDir, normalizeRun, runFolderStamp, writeRunMeta } from "../../src/core/runs.js";
import { parseSkill, skillDocument, Store } from "../../src/core/store.js";
import { createTask, requestExecute, syncTaskWithRun } from "../../src/core/tasks.js";
import { BUILTIN_PALETTE, companionColor, contrast, paletteFromFiles, parseFlatToml, readableMuted, toHex } from "../../src/core/theme.js";
import type { RunMeta } from "../../src/core/types.js";
import { gitHead, snapshotGit, summarizeSnapshot } from "../../src/core/vcs.js";
import { addWorkspaceRecord, removeWorkspaceRecord, selectWorkspaceRecord, updateWorkspaceRecord } from "../../src/core/workspaces.js";
import { joinArgs, shellQuote, splitArgs, timeAgo } from "../../src/shared/text.js";

function tempDir(prefix = "vibeforge-core-"): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

describe("places", () => {
  it("treats a folder as inside itself and rejects a shared prefix", () => {
    expect(isPathInside("/tmp/proj", "/tmp/proj")).toBe(true);
    expect(isPathInside("/tmp/proj", "/tmp/proj/src/deep")).toBe(true);
    expect(isPathInside("/tmp/proj", "/tmp/proj-other")).toBe(false);
    expect(isPathInside("/tmp/proj", "/tmp")).toBe(false);
    expect(isPathInside("/tmp/proj", "/tmp/proj/..hidden")).toBe(true);
    expect(cwdAllowed("/tmp/proj/src", ["/elsewhere", "/tmp/proj"])).toBe(true);
    expect(cwdAllowed("", ["/tmp/proj"])).toBe(false);
  });
});

describe("preamble", () => {
  it("carries the brief, memory, skills and prompt, and drops the memory starter note", () => {
    const text = buildPreamble({
      agentName: "Release notes",
      places: ["/tmp/a", "/tmp/b"],
      brief: "Draft release notes.",
      memory: "<!-- note to the human -->\n- 2026-09-01 prefer short bullets\n",
      skills: [
        { name: "release-notes", body: "## When\nMerged work." },
        { name: "empty", body: "   " },
      ],
      prompt: "Look at yesterday.",
    });
    expect(text.startsWith("# VibeForge run\nAgent: Release notes\n")).toBe(true);
    expect(text).toContain("- /tmp/a\n- /tmp/b");
    expect(text).toContain("## Brief\nDraft release notes.");
    expect(text).toContain("## Memory\n- 2026-09-01 prefer short bullets");
    expect(text).not.toContain("note to the human");
    expect(text).toContain("## Skill: release-notes\n## When\nMerged work.");
    expect(text).not.toContain("## Skill: empty");
    expect(text.trimEnd().endsWith("# This run\nLook at yesterday.")).toBe(true);
    expect(text).not.toContain("Previous attempt");
  });

  it("points at a previous transcript only when asked", () => {
    const text = buildPreamble({ agentName: "A", places: ["/x"], brief: "B", memory: "", skills: [], prompt: "P", priorTranscript: "/runs/1/transcript.txt" });
    expect(text).toContain("## Previous attempt");
    expect(text).toContain("/runs/1/transcript.txt");
    expect(memoryForPrompt("<!-- only a note -->\n")).toBe("");
    expect(taskPrompt("Fix lamp", "Warm it")).toBe("Task: Fix lamp\n\nWarm it");
  });
});

describe("engines", () => {
  it("resolves binaries on PATH without spawning which", () => {
    const dir = tempDir();
    const bin = path.join(dir, "fake-cli");
    fs.writeFileSync(bin, "#!/bin/sh\n");
    fs.chmodSync(bin, 0o755);
    fs.writeFileSync(path.join(dir, "not-exec"), "");
    expect(whichBin("fake-cli", `/nope:${dir}`)).toBe(bin);
    expect(whichBin("not-exec", dir)).toBeNull();
    expect(whichBin(bin, "")).toBe(bin);
    expect(whichBin("", dir)).toBeNull();
    const rows = withAvailability([{ id: "a", label: "A", bin: "fake-cli", args: [] }, { id: "b", label: "B", bin: "missing", args: [] }], (name) => whichBin(name, dir));
    expect(rows.map((row) => [row.id, row.available, row.path])).toEqual([
      ["a", true, bin],
      ["b", false, null],
    ]);
  });

  it("passes the prompt as an argument, pastes it, or points at a file when it is too long", () => {
    const claude = seedEngines().find((row) => row.id === "claude")!;
    expect(planLaunch(claude, "/bin/claude", { prompt: "line one\nline two" })).toEqual({ argv: ["/bin/claude", "line one\nline two"], pasteInput: null });
    expect(planLaunch(claude, "/bin/claude", { prompt: "" })).toEqual({ argv: ["/bin/claude"], pasteInput: null });
    expect(planLaunch(claude, "/bin/claude", { continueSession: true }).argv).toEqual(["/bin/claude", "--continue"]);
    const gemini = seedEngines().find((row) => row.id === "gemini")!;
    expect(planLaunch(gemini, "/bin/gemini", { prompt: "hi" }).argv).toEqual(["/bin/gemini", "-i", "hi"]);
    const pasted = planLaunch({ id: "x", label: "X", bin: "x", args: ["--flag"] }, "/bin/x", { prompt: "hello" });
    expect(pasted).toEqual({ argv: ["/bin/x", "--flag"], pasteInput: "hello" });
    const huge = "x".repeat(150_000);
    const long = planLaunch(claude, "/bin/claude", { prompt: huge, promptFile: "/runs/1/preamble.md" });
    expect(long.argv[1]).toContain("/runs/1/preamble.md");
    expect(long.pasteInput).toBeNull();
  });

  it("finds the exact session a CLI said to resume, for that CLI only", () => {
    const [claude, codex, grok] = ["claude", "codex", "grok"].map((id) => seedEngines().find((row) => row.id === id)!);
    const claudeText = "● done\nResume this session with:\nclaude --resume e6ea7991-1d65-4897-a691-d1edeedb9275\n";
    expect(resumeArgsFromTranscript(claude, claudeText)).toEqual(["--resume", "e6ea7991-1d65-4897-a691-d1edeedb9275"]);
    expect(resumeArgsFromTranscript(grok, claudeText)).toBeNull();
    expect(resumeArgsFromTranscript(grok, "Resume this session with:\n  grok --resume 01a0d5e8-2cf3-7c53-a4cd-7222d18f1757")).toEqual(["--resume", "01a0d5e8-2cf3-7c53-a4cd-7222d18f1757"]);
    expect(resumeArgsFromTranscript(codex, "To continue this session, run codex resume 0199a1b2-c3d4-7e5f")).toEqual(["resume", "0199a1b2-c3d4-7e5f"]);
    expect(resumeArgsFromTranscript(claude, "nothing to see")).toBeNull();
    const plan = planLaunch(claude, "/bin/claude", { continueSession: true, resumeArgs: ["--resume", "abc12345"] });
    expect(plan.argv).toEqual(["/bin/claude", "--resume", "abc12345"]);
  });

  it("normalises hand-edited engines.json rows", () => {
    const rows = normalizeEngineRows({
      engines: [
        { id: "a", bin: "a", args: ["--x", 3], promptArgs: [], continueArgs: ["-c"] },
        { id: "a", label: "duplicate" },
        { label: "no id" },
        { id: "b" },
      ],
    });
    expect(rows).toEqual([
      { id: "a", label: "a", bin: "a", args: ["--x"], continueArgs: ["-c"] },
      { id: "b", label: "b", bin: "b", args: [] },
    ]);
  });
});

describe("routines", () => {
  const base = {
    now: new Date("2026-09-25T09:00:30"),
    appStartedAt: new Date("2026-09-25T08:00:00"),
    enabled: true,
    allowRoutines: true,
    engineAvailable: true,
    schedule: { kind: "cron" as const, expr: "0 9 * * 1-5" },
    lastFiredAt: null,
    previousStillRunning: false,
  };

  it("validates five-field cron and whole intervals of five minutes or more", () => {
    expect(isScheduleValid({ kind: "cron", expr: "0 9 * * 1-5" })).toBe(true);
    expect(isScheduleValid({ kind: "cron", expr: "0 0 9 * * 1-5" })).toBe(false);
    expect(isScheduleValid({ kind: "cron", expr: "nonsense" })).toBe(false);
    expect(isScheduleValid({ kind: "every", minutes: 5 })).toBe(true);
    expect(isScheduleValid({ kind: "every", minutes: 4 })).toBe(false);
    expect(isScheduleValid({ kind: "every", minutes: 7.5 })).toBe(false);
  });

  it("finds a slot that lands exactly on now", () => {
    expect(mostRecentSlot(base.schedule, new Date("2026-09-25T09:00:00"))?.getTime()).toBe(new Date("2026-09-25T09:00:00").getTime());
  });

  it("fires a slot that arrived while running, records one that passed while closed", () => {
    expect(decideRoutineTick(base)).toEqual({ action: "fire", scheduledAt: new Date("2026-09-25T09:00:00").toISOString() });
    expect(decideRoutineTick({ ...base, appStartedAt: new Date("2026-09-25T09:00:10") }).action).toBe("miss");
    expect(decideRoutineTick({ ...base, lastFiredAt: new Date("2026-09-25T09:00:00").toISOString() })).toEqual({ action: "skip", reason: "not-due" });
    expect(decideRoutineTick({ ...base, previousStillRunning: true })).toEqual({ action: "skip", reason: "still-running" });
    expect(decideRoutineTick({ ...base, enabled: false })).toEqual({ action: "skip", reason: "disabled" });
    expect(decideRoutineTick({ ...base, allowRoutines: false })).toEqual({ action: "skip", reason: "disallowed" });
    expect(decideRoutineTick({ ...base, engineAvailable: false })).toEqual({ action: "skip", reason: "engine-missing" });
  });

  it("lets run now through while paused but not while disallowed, missing or overlapping", () => {
    expect(decideRunNow({ allowRoutines: true, engineAvailable: true, previousStillRunning: false })).toEqual({ ok: true });
    expect(decideRunNow({ allowRoutines: false, engineAvailable: true, previousStillRunning: false })).toEqual({ ok: false, reason: "disallowed" });
    expect(decideRunNow({ allowRoutines: true, engineAvailable: false, previousStillRunning: false })).toEqual({ ok: false, reason: "engine-missing" });
    expect(decideRunNow({ allowRoutines: true, engineAvailable: true, previousStillRunning: true })).toEqual({ ok: false, reason: "still-running" });
  });

  it("previews weekday fires and lines intervals up with local midnight", () => {
    const fires = nextFireTimes(base.schedule, new Date("2026-09-25T10:00:00"), 3);
    expect(fires.map((date) => [date.getDay(), date.getHours(), date.getMinutes()])).toEqual([
      [1, 9, 0],
      [2, 9, 0],
      [3, 9, 0],
    ]);
    const hourly = nextFireTimes({ kind: "every", minutes: 60 }, new Date("2026-09-25T10:17:00"), 2);
    expect(hourly.map((date) => [date.getHours(), date.getMinutes()])).toEqual([
      [11, 0],
      [12, 0],
    ]);
    expect(describeSchedule({ kind: "every", minutes: 90 })).toBe("Every 90 minutes");
    expect(describeSchedule({ kind: "every", minutes: 120 })).toBe("Every 2 hours");
    expect(describeSchedule(base.schedule)).toMatch(/09:00/);
  });
});

describe("tasks", () => {
  it("stays in todo until execute, which needs the workspace inside the agent's folders", () => {
    const task = createTask({ title: "Dim lamp", body: "Warm it", now: new Date("2026-09-25T00:00:00Z") });
    expect(task.status).toBe("todo");
    expect(task.runIds).toEqual([]);
    expect(task.id).toMatch(/^dim-lamp-[0-9a-f]{6}$/);
    expect(requestExecute(task, { hasAgent: false, workspacePath: "/w", agentPlaces: ["/w"] })).toEqual({ ok: false, reason: "missing-agent" });
    expect(requestExecute(task, { hasAgent: true, workspacePath: "", agentPlaces: ["/w"] })).toEqual({ ok: false, reason: "missing-workspace" });
    expect(requestExecute(task, { hasAgent: true, workspacePath: "/other", agentPlaces: ["/w"] })).toEqual({ ok: false, reason: "outside-places" });
    const ok = requestExecute(task, { hasAgent: true, workspacePath: "/w/app", agentPlaces: ["/w"] });
    expect(ok.ok && ok.task.status).toBe("running");
    expect(syncTaskWithRun({ ...task, status: "running" }, "exited")).toBe("review");
    expect(syncTaskWithRun({ ...task, status: "running" }, "failed")).toBe("review");
    expect(syncTaskWithRun({ ...task, status: "running" }, "running")).toBe("running");
    expect(syncTaskWithRun(task, "exited")).toBe("todo");
  });
});

describe("workspaces", () => {
  it("adds once per folder, removes without touching disk, and updates fields", () => {
    const dir = tempDir();
    let file = addWorkspaceRecord({ workspaces: [], lastWorkspaceId: null }, dir);
    file = addWorkspaceRecord(file, dir);
    expect(file.workspaces).toHaveLength(1);
    const id = file.workspaces[0].id;
    file = updateWorkspaceRecord(file, id, { dockUrl: "http://127.0.0.1:5173", name: "App" });
    expect(file.workspaces[0]).toMatchObject({ dockUrl: "http://127.0.0.1:5173", name: "App" });
    expect(selectWorkspaceRecord(file, "missing")).toBe(file);
    file = removeWorkspaceRecord(file, id);
    expect(file).toEqual({ workspaces: [], lastWorkspaceId: null });
    expect(fs.existsSync(dir)).toBe(true);
  });
});

describe("theme", () => {
  const colors = fs.readFileSync(path.join(__dirname, "fixtures", "colors.toml"), "utf8");

  it("reads an Omarchy colors.toml and a ghostty palette", () => {
    const palette = paletteFromFiles({ name: "Apex Forge", colors, ghostty: "palette = 7=#a1a1aa\ncursor-color = #FF6B35\nselection-background = #4a2110\n" })!;
    expect(palette.accent).toBe("#ff6b35");
    expect(palette.accent2).toBe("#fca311");
    expect(palette.mode).toBe("dark");
    expect(palette.terminal.ansi[7]).toBe("#a1a1aa");
    expect(palette.terminal.selectionBackground).toBe("#4a2110");
    expect(palette.terminal.ansi).toHaveLength(16);
  });

  it("pairs an accent with its nearest palette hue and keeps faint text readable", () => {
    const omarchy = (colors: Record<string, string>) =>
      paletteFromFiles({ name: "t", colors: Object.entries(colors).map(([key, value]) => `${key} = "${value}"`).join("\n") })!;
    const tokyo = omarchy({ background: "#1a1b26", foreground: "#a9b1d6", accent: "#7aa2f7", muted: "#414868", red: "#f7768e", yellow: "#e0af68", green: "#9ece6a", cyan: "#449dab", blue: "#7aa2f7", magenta: "#ad8ee6" });
    expect(tokyo.accent2).toBe("#449dab");
    expect(contrast(tokyo.muted, tokyo.background)).toBeGreaterThanOrEqual(3.4);
    const nord = omarchy({ background: "#2e3440", foreground: "#d8dee9", accent: "#81a1c1", red: "#bf616a", yellow: "#ebcb8b", green: "#a3be8c", cyan: "#88c0d0", blue: "#81a1c1", magenta: "#b48ead" });
    expect(nord.accent2).toBe("#88c0d0");
    expect(companionColor("#808080", ["#808080"], "#fca311")).toBe("#fca311");
    expect(readableMuted("#71717a", "#ffffff", "#09090b")).toBe("#71717a");
  });

  it("detects light themes and survives odd colour formats", () => {
    const light = paletteFromFiles({ name: "Paper", colors: 'background = "#fafafa"\nforeground = "#111111"\naccent = "#0055ff"\n' })!;
    expect(light.mode).toBe("light");
    expect(light.accent2).toBe(BUILTIN_PALETTE.blue);
    expect(paletteFromFiles({ name: "Broken", colors: 'accent = "#fff"' })).toBeNull();
    expect(toHex("rgba(ff6b35ee)")).toBe("#ff6b35");
    expect(toHex("rgb(255, 107, 53)")).toBe("#ff6b35");
    expect(toHex("#ABC")).toBe("#aabbcc");
    expect(toHex("nope")).toBeNull();
    expect(parseFlatToml('# comment\nkey = "#ffffff" # trailing\nother = \'x\'\n')).toEqual({ key: "#ffffff", other: "x" });
  });
});

describe("git snapshot", () => {
  it("summarises status, diff, new files and commits since the run started", async () => {
    const dir = tempDir();
    expect((await snapshotGit(dir)).trim()).toBe("not a git repo");
    expect(await gitHead(dir)).toBeNull();
    const git = (...args: string[]) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd: dir, stdio: "pipe" });
    git("init", "-q");
    // Plenty of dotfiles force colour even into pipes; the snapshot must stay plain text.
    git("config", "color.ui", "always");
    fs.writeFileSync(path.join(dir, "a.txt"), "one\n");
    git("add", "a.txt");
    git("commit", "-qm", "init");
    const start = await gitHead(dir);
    expect(start).toMatch(/^[0-9a-f]{40}$/);
    fs.writeFileSync(path.join(dir, "b.txt"), "two\n");
    git("add", "b.txt");
    git("commit", "-qm", "second");
    fs.writeFileSync(path.join(dir, "a.txt"), "one\nmore\n");
    fs.writeFileSync(path.join(dir, "new.txt"), "fresh\n");
    const text = await snapshotGit(dir, 5000, start);
    expect(text).toContain("git status --short");
    expect(text).toContain(" M a.txt");
    expect(text).toContain("?? new.txt");
    expect(text).toContain("commits since the run started");
    expect(summarizeSnapshot(text)).toBe("1 commit · 1 file changed, 1 insertion(+) · 1 new file");
    expect(summarizeSnapshot("not a git repo\n")).toBeNull();
  });
});

describe("store", () => {
  it("round-trips a SKILL.md and reindexes run folders it did not write", () => {
    const skill = parseSkill("notes", skillDocument({ id: "notes", name: "Notes", description: "Use for notes.", body: "## When\nAlways." }));
    expect(skill).toEqual({ id: "notes", name: "Notes", description: "Use for notes.", body: "## When\nAlways." });
    expect(parseSkill("raw", "no front matter")).toEqual({ id: "raw", name: "raw", description: "", body: "no front matter" });

    const configRoot = tempDir();
    const dataRoot = tempDir();
    const store = new Store(configRoot, dataRoot);
    const { id, dir } = allocateRunDir(dataRoot, new Date("2026-09-25T09:00:01Z"), "Weekday Notes!");
    expect(id).toBe("2026-09-25T090001Z_weekday-notes");
    const meta = normalizeRun({ id, dir, origin: "routine", status: "exited", startedAt: "2026-09-25T09:00:01.000Z", title: "Notes", routineId: "weekday" }) as RunMeta;
    writeRunMeta(meta);
    expect(store.reindex()).toBe(1);
    expect(store.queryRuns({ routineId: "weekday" }).map((run) => run.id)).toEqual([id]);
    expect(store.queryRuns({ status: "running" })).toEqual([]);
    store.saveRun({ ...meta, openedAt: "2026-09-25T10:00:00.000Z" });
    expect(store.queryRuns({ unopened: true })).toEqual([]);
    expect(JSON.parse(fs.readFileSync(path.join(dir, "meta.json"), "utf8")).openedAt).toBe("2026-09-25T10:00:00.000Z");
    expect(runFolderStamp(new Date("2026-01-02T03:04:05.678Z"))).toBe("2026-01-02T030405Z");
    store.close();
  });

  it("seeds engines.json and settings.json on first read", () => {
    const store = new Store(tempDir(), tempDir());
    expect(store.readEngineRows().map((row) => row.id)).toContain("claude");
    expect(fs.existsSync(path.join(store.configRoot, "engines.json"))).toBe(true);
    expect(store.readSettings().theme).toBe("omarchy");
    expect(store.readSettings().tourDone).toBe(false);
    store.close();
  });

  it("keeps the tour finished once it is, and reads older settings files as not toured", () => {
    const store = new Store(tempDir(), tempDir());
    const file = path.join(store.configRoot, "settings.json");
    fs.writeFileSync(file, JSON.stringify({ defaultEngine: "codex", theme: "builtin" }));
    expect(store.readSettings()).toMatchObject({ defaultEngine: "codex", theme: "builtin", tourDone: false });
    store.writeSettings({ ...store.readSettings(), tourDone: true });
    expect(store.readSettings().tourDone).toBe(true);
    fs.writeFileSync(file, JSON.stringify({ tourDone: "yes" }));
    expect(store.readSettings().tourDone).toBe(false);
    store.close();
  });
});

describe("files", () => {
  it("lists one level, folders first, dependencies dimmed and .git hidden", () => {
    const dir = tempDir();
    fs.mkdirSync(path.join(dir, ".git"));
    fs.mkdirSync(path.join(dir, "node_modules"));
    fs.mkdirSync(path.join(dir, "src"));
    fs.writeFileSync(path.join(dir, "b.txt"), "");
    fs.writeFileSync(path.join(dir, "a.txt"), "");
    expect(listDir(dir).map((node) => [node.name, node.kind, Boolean(node.quiet)])).toEqual([
      ["src", "dir", false],
      ["node_modules", "dir", true],
      ["a.txt", "file", false],
      ["b.txt", "file", false],
    ]);
  });
});

describe("text helpers", () => {
  it("quotes paths for a shell and splits argument strings back", () => {
    expect(shellQuote("/tmp/plain-path.txt")).toBe("/tmp/plain-path.txt");
    expect(shellQuote("/tmp/it's here")).toBe(`'/tmp/it'\\''s here'`);
    for (const args of [["-i", "{prompt}"], ["--model", "two words", 'say "hi"', "back\\slash", ""]]) {
      expect(splitArgs(joinArgs(args))).toEqual(args);
    }
    const now = Date.parse("2026-09-25T12:00:00Z");
    expect(timeAgo("2026-09-25T11:59:50Z", now)).toBe("just now");
    expect(timeAgo("2026-09-25T11:30:00Z", now)).toBe("30 min ago");
    expect(timeAgo("2026-09-25T15:00:00Z", now)).toBe("in 3 hr");
  });
});
