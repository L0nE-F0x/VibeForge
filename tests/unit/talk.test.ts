import { describe, expect, it } from "vitest";
import { controlSocketPath, hyprlandBindings, parseControl, voiceArg } from "../../src/core/control.js";
import { claudeLogCwd, claudeProjectDir, claudeTurn, codexLogCwd, codexTurn, mentions, replyLogFor, speakable } from "../../src/core/replies.js";
import { Endpointer, findPiper, isVoiceFile, pickVoice, planPlayer, voiceName, voiceRate } from "../../src/core/voice.js";
import { parseUtterance } from "../../src/shared/commands.js";

const at = (seconds: number) => new Date(Date.UTC(2026, 8, 26, 12, 0, seconds)).toISOString();
const since = Date.parse(at(10));
const jsonl = (rows: unknown[]) => rows.map((row) => JSON.stringify(row)).join("\n") + "\n";

describe("talk: the end of a sentence", () => {
  const run = (frames: Array<[number, number]>, opts = {}) => {
    const endpointer = new Endpointer(opts);
    const phases: string[] = [];
    for (const [loudness, count] of frames) for (let i = 0; i < count; i++) phases.push(endpointer.push(loudness, 30));
    return { endpointer, phases };
  };

  it("waits through room noise, hears speech, and ends after a pause", () => {
    const { endpointer, phases } = run([
      [0.003, 30],
      [0.08, 40],
      [0.003, 30],
    ]);
    expect(phases[29]).toBe("waiting");
    expect(phases[35]).toBe("speaking");
    expect(endpointer.phase).toBe("ended");
  });

  it("doesn't end on a short breath, or count a click as speech", () => {
    expect(run([[0.003, 20], [0.08, 40], [0.003, 10], [0.08, 10]]).endpointer.phase).toBe("speaking");
    expect(run([[0.003, 20], [0.2, 2], [0.003, 40]]).endpointer.phase).toBe("waiting");
  });

  it("times out when nobody speaks, and adapts to a noisy room", () => {
    expect(run([[0.003, 700]]).endpointer.phase).toBe("timeout");
    // A fan at 0.03: speech has to rise well above it.
    expect(run([[0.03, 100]]).endpointer.phase).toBe("waiting");
    expect(run([[0.03, 30], [0.2, 30], [0.03, 30]]).endpointer.phase).toBe("ended");
  });
});

describe("talk: Piper", () => {
  const has = (...bins: string[]) => (bin: string) => (bins.includes(bin) ? `/usr/bin/${bin}` : null);

  it("finds Piper and a player that reads raw audio at the voice's rate", () => {
    expect(findPiper(has("piper"))).toBe("/usr/bin/piper");
    expect(findPiper(has("piper-tts"))).toBe("/usr/bin/piper-tts");
    expect(findPiper(has())).toBeNull();
    expect(planPlayer(has("pw-play", "aplay"))?.argv(22050)).toEqual(expect.arrayContaining(["/usr/bin/pw-play", "--rate", "22050", "--raw", "-"]));
    expect(planPlayer(has("paplay"))?.argv(16000)).toContain("--rate=16000");
    expect(planPlayer(has("aplay"))?.label).toBe("aplay");
    expect(planPlayer(has())).toBeNull();
    expect(planPlayer(has(), "cat > /tmp/x")?.argv(22050)).toEqual(["/bin/sh", "-c", "RATE=22050; cat > /tmp/x"]);
  });

  it("knows a voice by its .onnx.json and prefers one in the app's language", () => {
    expect(isVoiceFile("en_US-lessac-medium.onnx", new Set(["en_US-lessac-medium.onnx.json"]))).toBe(true);
    expect(isVoiceFile("en_US-lessac-medium.onnx", new Set())).toBe(false);
    expect(voiceName("/v/de_DE-thorsten-medium.onnx")).toBe("de_DE-thorsten-medium");
    const found = ["/v/de_DE-thorsten-medium.onnx", "/v/en_GB-alan-medium.onnx"];
    expect(pickVoice(found, "/v/en_GB-alan-medium.onnx", "de")).toBe("/v/en_GB-alan-medium.onnx");
    expect(pickVoice(found, "", "en")).toBe("/v/en_GB-alan-medium.onnx");
    expect(pickVoice(found, "/gone.onnx", "ja")).toBe("/v/de_DE-thorsten-medium.onnx");
    expect(pickVoice([], "", "en")).toBeNull();
    expect(voiceRate({ audio: { sample_rate: 16000 } })).toBe(16000);
    expect(voiceRate({})).toBe(22050);
  });
});

describe("talk: Claude Code's session log", () => {
  const prompt = (seconds: number, content: unknown, extra = {}) => ({ type: "user", timestamp: at(seconds), cwd: "/work", message: { role: "user", content }, ...extra });
  const assistant = (seconds: number, id: string, content: unknown[], stop: string | null) => ({ type: "assistant", timestamp: at(seconds), message: { id, role: "assistant", content, stop_reason: stop } });

  const log = jsonl([
    { type: "permission-mode", timestamp: at(0) },
    prompt(1, "an older question"),
    assistant(2, "m0", [{ type: "text", text: "An older answer." }], "end_turn"),
    prompt(11, "Add tests for the scheduler please"),
    assistant(12, "m1", [{ type: "thinking", thinking: "…" }], null),
    assistant(12, "m1", [{ type: "tool_use", id: "t1", name: "Read" }], "tool_use"),
    prompt(13, [{ type: "tool_result", tool_use_id: "t1", content: "file" }]),
    assistant(14, "m2", [{ type: "text", text: "Done. I added **three** tests.\n\nThey all pass." }], null),
    assistant(14, "m2", [{ type: "text", text: "Run `npm test` to see." }], "end_turn"),
  ]);

  it("finds the turn after the prompt and reads its final message, skipping tool results", () => {
    const turn = claudeTurn(log, since, "add tests for the scheduler");
    expect(turn).toEqual({ prompted: true, matched: true, reply: "Done. I added **three** tests.\n\nThey all pass.\n\nRun `npm test` to see." });
  });

  it("waits while the agent is still working, and ignores what came before", () => {
    const working = jsonl([prompt(11, "Add tests"), assistant(12, "m1", [{ type: "tool_use", id: "t" }], "tool_use")]);
    expect(claudeTurn(working, since)).toEqual({ prompted: true, matched: false, reply: null });
    expect(claudeTurn(log, Date.parse(at(20)))).toEqual({ prompted: false, matched: false, reply: null });
  });

  it("skips meta rows and slash commands, and survives a half-written line", () => {
    const noisy = jsonl([
      prompt(11, "<command-name>/effort</command-name>"),
      prompt(11, "caveat", { isMeta: true }),
      prompt(12, [{ type: "text", text: "Real prompt" }]),
      assistant(13, "m", [{ type: "text", text: "Real answer." }], "end_turn"),
    ]) + '{"type":"assist';
    expect(claudeTurn(noisy, since).reply).toBe("Real answer.");
    expect(claudeLogCwd(noisy)).toBe("/work");
  });

  it("names Claude Code's project folder the way it does", () => {
    expect(claudeProjectDir("/home/me", "/home/me/Projects/ApexForge/VibeForge")).toBe("/home/me/.claude/projects/-home-me-Projects-ApexForge-VibeForge");
    expect(claudeProjectDir("/h", "/h/.local/share/x_y")).toBe("/h/.claude/projects/-h--local-share-x-y");
  });
});

describe("talk: Codex's rollout log", () => {
  const event = (seconds: number, payload: object) => ({ timestamp: at(seconds), type: "event_msg", payload });
  const log = jsonl([
    { timestamp: at(0), type: "session_meta", payload: { id: "s", cwd: "/work" } },
    event(11, { type: "user_message", message: "Fix the login page" }),
    event(12, { type: "agent_message", message: "Looking at it." }),
    event(20, { type: "task_complete", last_agent_message: "Fixed. The form now validates the email." }),
  ]);

  it("reads the last agent message when the task completes", () => {
    expect(codexTurn(log, since, "fix the login page")).toEqual({ prompted: true, matched: true, reply: "Fixed. The form now validates the email." });
    expect(codexLogCwd(log)).toBe("/work");
    const unfinished = jsonl([event(11, { type: "user_message", message: "Hi" }), event(12, { type: "agent_message", message: "…" })]);
    expect(codexTurn(unfinished, since).reply).toBeNull();
  });

  it("knows which engines leave a log to read", () => {
    expect(replyLogFor("claude", "claude")).toBe("claude");
    expect(replyLogFor("my-claude", "/opt/claude")).toBe("claude");
    expect(replyLogFor("codex", "codex")).toBe("codex");
    expect(replyLogFor("grok", "grok")).toBeNull();
    expect(mentions("Please: add tests for the scheduler, thanks", "Add tests for the scheduler.")).toBe(true);
    expect(mentions("something else", "Add tests")).toBe(false);
  });
});

describe("talk: what gets said", () => {
  const reply = [
    "## Done",
    "",
    "I added **three** tests to `scheduler.test.ts` and [the docs](https://example.com/docs). See https://x.dev for more.",
    "",
    "```ts",
    "it('works', () => {});",
    "expect(1).toBe(1);",
    "```",
    "",
    "- first thing",
    "- second thing",
    "",
    "| a | b |",
    "|---|---|",
  ].join("\n");

  it("summarises as the first paragraph of plain words", () => {
    expect(speakable(reply, "summary")).toBe("Done.");
    expect(speakable("I added **three** tests to `x.ts`.\n\nMore.", "summary")).toBe("I added three tests to x.ts.");
    expect(speakable(reply, "off")).toBe("");
  });

  it("reads everything but the table, and describes code instead of reading it", () => {
    const full = speakable(reply, "full");
    expect(full).toContain("I added three tests to scheduler.test.ts and the docs. See a link for more.");
    expect(full).toContain("A code block, 2 lines.");
    expect(full).toContain("first thing. second thing.");
    expect(full).not.toContain("|");
    expect(full).not.toContain("expect(1)");
  });

  it("clips a long summary at a sentence", () => {
    const long = `${"This sentence is fine. ".repeat(30)}`;
    const said = speakable(long, "summary");
    expect(said.length).toBeLessThanOrEqual(360);
    expect(said.endsWith(".")).toBe(true);
  });
});

describe("talk: what a sentence is for", () => {
  const context = { agents: [{ id: "atlas", name: "Atlas" }, { id: "code-review", name: "Code Review" }], routines: [{ id: "nightly", name: "Nightly review" }] };
  const parse = (text: string) => parseUtterance(text, context);

  it("leaves ordinary words alone", () => {
    expect(parse("Refactor the scheduler, then run the tests.")).toEqual({ kind: "text", text: "Refactor the scheduler, then run the tests." });
    expect(parse("Stop the server if it's running.")).toEqual({ kind: "text", text: "Stop the server if it's running." });
    expect(parse("Forge the sword.")).toEqual({ kind: "text", text: "Forge the sword." });
    expect(parse("Bob, fix it.")).toEqual({ kind: "text", text: "Bob, fix it." });
  });

  it("addresses an agent by name, however whisper punctuates it", () => {
    expect(parse("Atlas, add tests for the scheduler.")).toEqual({ kind: "agent", agentId: "atlas", text: "Add tests for the scheduler." });
    expect(parse("Hey Atlas: what changed?")).toEqual({ kind: "agent", agentId: "atlas", text: "What changed?" });
    expect(parse("code review, look at the diff")).toEqual({ kind: "agent", agentId: "code-review", text: "Look at the diff" });
    expect(parse("Tell Atlas to update the docs.")).toEqual({ kind: "agent", agentId: "atlas", text: "Update the docs." });
    expect(parse("Ask Code Review to check the PR")).toEqual({ kind: "agent", agentId: "code-review", text: "Check the PR" });
  });

  it("takes commands after the wake word", () => {
    const command = (text: string) => {
      const result = parse(text);
      return result.kind === "command" ? result.command : result;
    };
    expect(command("Forge, send.")).toEqual({ type: "send" });
    expect(command("VibeForge, send it!")).toEqual({ type: "send" });
    expect(command("Forge. Clear.")).toEqual({ type: "clear" });
    expect(command("Forge, stop.")).toEqual({ type: "stop" });
    expect(command("Forge, keep going")).toEqual({ type: "continue" });
    expect(command("Hey Forge, stop listening.")).toEqual({ type: "stopListening" });
    expect(command("Forge, go to tasks.")).toEqual({ type: "open", view: "tasks" });
    expect(command("Forge, open the routine page")).toEqual({ type: "open", view: "routines" });
    expect(command("Forge, new task: fix the login page.")).toEqual({ type: "newTask", title: "Fix the login page", agentId: null });
    expect(command("Forge, create a task for Atlas, write release notes")).toEqual({ type: "newTask", title: "Write release notes", agentId: "atlas" });
    expect(command("Forge, run the nightly review routine.")).toEqual({ type: "runRoutine", routineId: "nightly" });
    expect(command("Forge, run routine nightly review")).toEqual({ type: "runRoutine", routineId: "nightly" });
    expect(command("Forge, make me a sandwich.")).toEqual({ type: "unknown", text: "make me a sandwich" });
    expect(command("Forge.")).toEqual({ type: "unknown", text: "" });
    // What whisper really wrote for Piper saying these.
    expect(command("forge new task. Fix the login page.")).toEqual({ type: "newTask", title: "Fix the login page", agentId: null });
    expect(command("Forge, New task. Fix the login page.")).toEqual({ type: "newTask", title: "Fix the login page", agentId: null });
    expect(command("Forge, Go to Tasks.")).toEqual({ type: "open", view: "tasks" });
  });
});

describe("talk: the control socket", () => {
  it("puts one socket per data folder in the runtime folder, briefly named", () => {
    const a = controlSocketPath("/home/me/.local/share/vibeforge", "/run/user/1000", 1000);
    expect(a).toMatch(/^\/run\/user\/1000\/vibeforge-[0-9a-f]{8}\.sock$/);
    expect(controlSocketPath("/tmp/other", "/run/user/1000", 1000)).not.toBe(a);
    expect(controlSocketPath("/x", undefined, 42)).toMatch(/^\/tmp\/vibeforge-42-[0-9a-f]{8}\.sock$/);
  });

  it("understands voice actions from the socket and from a second instance's arguments", () => {
    expect(parseControl("voice start")).toBe("start");
    expect(parseControl(" voice converse \n")).toBe("converse");
    expect(parseControl("voice explode")).toBeNull();
    expect(parseControl("rm -rf")).toBeNull();
    expect(voiceArg(["electron", ".", "--voice", "stop"])).toBe("stop");
    expect(voiceArg(["electron", "--voice=toggle"])).toBe("toggle");
    expect(voiceArg(["electron", "--voice"])).toBe("toggle");
    expect(voiceArg(["electron", "."])).toBeNull();
  });

  it("writes Hyprland bindings for Omarchy's Lua config and for hyprland.conf", () => {
    const lua = hyprlandBindings("vibeforge", true);
    expect(lua).toContain('o.bind("SUPER + ALT + V", "VibeForge: hold to talk", "vibeforge --voice start")');
    expect(lua).toContain('"vibeforge --voice stop", { release = true })');
    expect(lua).toContain("--voice converse");
    const conf = hyprlandBindings("/opt/vf/scripts/vibeforge", false);
    expect(conf).toContain("bindr = SUPER ALT, V, exec, /opt/vf/scripts/vibeforge --voice stop");
  });
});
