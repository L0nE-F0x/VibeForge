#!/usr/bin/env node
// One stand-in for every coding CLI the end-to-end tests need. The driver installs a small wrapper
// under each CLI's name on a scratch PATH (e2e/driver/app.ts, `standins`), which runs
//
//   node standin.cjs <name> <folder> <the CLI's own arguments...>
//
// and <folder>/<name>.json steers it:
//
//   {
//     "plans": [{ "match": "regex", "structured": { "say": "...", "steps": [...] } }],
//     "turns": [{ "match": "regex", "say": ["line", ...], "files": { "path": "text" }, "gate": "name", "after": ["line"], "exit": 0 }]
//   }
//
// A headless planning turn (`--print`, as VibeForge asks Claude Code to plan; with `--input-format
// stream-json`, one answer per message on stdin until it closes) answers with the
// first plan whose `match` finds the person's words, in Claude Code's JSON result format. Any other
// start is an interactive turn, the first whose `match` finds its arguments: it prints `say`; if
// the turn has a `gate`, waits until the test opens it (<folder>/gates/<gate>); then writes `files`
// (relative to where it was started), prints `after` and exits. So a test can look at the CLI
// while it works, and its edits come after VibeForge has noted where the run started. Turns never end on a timer. Every start is logged as one JSON line
// in <folder>/<name>.calls.jsonl: arguments, folder and mode. "$HOME" in a plan becomes the home
// the CLI was started with.

const fs = require("node:fs");
const path = require("node:path");

const [name, folder, ...argv] = process.argv.slice(2);
if (!name || !folder) {
  process.stderr.write("usage: standin.cjs <name> <folder> [args...]\n");
  process.exit(2);
}

/** @returns {{ plans?: Array<{ match?: string, structured: unknown }>, turns?: Array<{ match?: string, say?: string[], files?: Record<string, string>, gate?: string, after?: string[], exit?: number }> }} */
function script() {
  try {
    return JSON.parse(fs.readFileSync(path.join(folder, `${name}.json`), "utf8"));
  } catch {
    return {};
  }
}

function log(entry) {
  fs.appendFileSync(path.join(folder, `${name}.calls.jsonl`), `${JSON.stringify({ name, cwd: process.cwd(), argv, ...entry })}\n`);
}

const matches = (pattern, text) => !pattern || new RegExp(pattern, "i").test(text);

const planning = argv.includes("--print") || argv.includes("-p");
const streamed = planning && argv[argv.indexOf("--input-format") + 1] === "stream-json";

/** Answers one planning message with the first plan whose `match` finds the person's words. */
function answerPlan(said) {
  // The planner's message ends with what the person said; the desk before it names everything else.
  const tail = said.slice(-600);
  const plan = (script().plans ?? []).find((item) => matches(item.match, tail));
  // "$HOME" in a plan is the home the app gave its CLIs: the test's scratch home.
  const structured = JSON.parse(JSON.stringify(plan?.structured ?? { say: "Stand-in answer.", steps: [] }).replaceAll("$HOME", (process.env.HOME ?? "").replace(/["\\]/g, "")));
  log({ mode: "plan", tail: tail.slice(-200), plan: plan?.match ?? null });
  process.stdout.write(
    `${JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "", structured_output: structured, session_id: "00000000-0000-4000-8000-000000000001" })}\n`,
  );
}

if (streamed) {
  // Viby's warm planner keeps Claude Code running and sends each message as a stream-json line on
  // stdin, so this answers every one of them until stdin closes, the way Claude Code does.
  let pending = "";
  process.stdin.on("data", (chunk) => {
    pending += chunk.toString();
    for (let newline = pending.indexOf("\n"); newline >= 0; newline = pending.indexOf("\n")) {
      const line = pending.slice(0, newline).trim();
      pending = pending.slice(newline + 1);
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      if (message?.type !== "user") continue;
      const content = message.message?.content;
      answerPlan(typeof content === "string" ? content : (content ?? []).filter((part) => part.type === "text").map((part) => part.text).join("\n"));
    }
  });
  process.stdin.on("end", () => process.exit(0));
} else if (planning) {
  // Claude Code takes the message after "--"; the others take it as the value of -p.
  const dash = argv.indexOf("--");
  answerPlan(dash >= 0 ? argv.slice(dash + 1).join(" ") : (argv[argv.indexOf("-p") + 1] ?? ""));
  process.exit(0);
} else {
  const turn = (script().turns ?? []).find((item) => matches(item.match, argv.join(" "))) ?? {};
  log({ mode: "turn", turn: turn.match ?? null });
  const say = (lines) => {
    for (const line of lines ?? []) process.stdout.write(`${line}\r\n`);
  };
  say(turn.say);
  const finish = () => {
    for (const [file, text] of Object.entries(turn.files ?? {})) {
      const target = path.resolve(process.cwd(), file);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, text);
    }
    say(turn.after);
    log({ mode: "done", turn: turn.match ?? null });
    process.exit(turn.exit ?? 0);
  };
  if (turn.gate) {
    const gates = path.join(folder, "gates");
    fs.mkdirSync(gates, { recursive: true });
    fs.writeFileSync(path.join(gates, `${turn.gate}.waiting`), "");
    const wait = () => (fs.existsSync(path.join(gates, turn.gate)) ? finish() : setTimeout(wait, 50));
    wait();
  } else finish();
}
