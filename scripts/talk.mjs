#!/usr/bin/env node
// `vibeforge tell`, `vibeforge who`, `vibeforge task` and `vibeforge apply`: coding CLIs in VibeForge's terminals
// talking to each other through the running window's control socket. One JSON line goes in, one
// comes back. The window knows which terminal asked from VIBEFORGE_PTY, which it sets in each one.
import net from "node:net";

const USAGE = `Talk to the other coding CLIs open in VibeForge.

  vibeforge who
      The CLIs you can reach (and which one is you), and the agents you can hand tasks to,
      with what each is good at.

  vibeforge tell <name> [--wait] [--timeout <minutes>] "<message>"
      Paste a message into another CLI once it is free, labelled with who sent it.
      --wait   wait for its answer and print it (up to 9 minutes, or --timeout).
      Without --wait it can answer you with vibeforge tell.
      Use - as the message to read it from standard input.

  vibeforge task <agent> [--title "<title>"] [--no-start] [--wait] [--timeout <minutes>] "<instructions>"
      Hand a task to a VibeForge agent. It works in its own git copy of your workspace,
      never in your folder; a person applies its changes from the task. When it finishes
      its turn, what it said and changed comes back to you as a message.
      --no-start  leave it in To do.   --wait  wait for its first answer and print it instead.
      Under Ask first (Settings → Agents together) it waits for a person to press Start.

  vibeforge apply <task-id>
      Bring a task you handed out into your folder as uncommitted changes, ending its
      session. Only when Settings → Agents together lets the CLI that handed it out.

Two CLIs may send each other a limited number of messages before a person has to
press Enter on the next one (Settings → Agents together). Exit codes: 0 done,
1 refused or failed, 2 usage, 3 still waiting for an answer.`;

function fail(message, code = 1) {
  process.stderr.write(`vibeforge: ${message}\n`);
  process.exit(code);
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

/** Flags anywhere, the first word after the command as the target, the rest as the text. */
function parse(args) {
  const flags = { wait: false, start: true, title: undefined, timeout: undefined };
  const words = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") {
      words.push(...args.slice(i + 1));
      break;
    }
    if (arg === "--wait") flags.wait = true;
    else if (arg === "--no-start") flags.start = false;
    else if (arg === "--title") flags.title = args[++i];
    else if (arg === "--timeout") flags.timeout = Number(args[++i]);
    else if (arg.startsWith("--title=")) flags.title = arg.slice(8);
    else if (arg.startsWith("--timeout=")) flags.timeout = Number(arg.slice(10));
    else if (arg.startsWith("--") && words.length === 0) fail(`unknown option ${arg}\n\n${USAGE}`, 2);
    else words.push(arg);
  }
  if (flags.timeout !== undefined && !(flags.timeout > 0)) fail("--timeout takes a number of minutes", 2);
  return { flags, words };
}

function ask(request) {
  const socket = process.env.VIBEFORGE_SOCKET;
  if (!socket) fail("VibeForge's control socket is unknown; run this from a VibeForge terminal.");
  return new Promise((resolve, reject) => {
    const client = net.connect(socket);
    let text = "";
    client.setEncoding("utf8");
    client.on("connect", () => client.write(`${JSON.stringify(request)}\n`));
    client.on("data", (chunk) => {
      text += chunk;
    });
    client.on("end", () => {
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new Error("VibeForge sent an answer that isn't JSON."));
      }
    });
    client.on("error", () => reject(new Error("VibeForge isn't running, or this terminal isn't one of its own.")));
  });
}

const [command, ...rest] = process.argv.slice(2);
if (!command || command === "help" || command === "--help" || command === "-h") {
  process.stdout.write(`${USAGE}\n`);
  process.exit(0);
}
const pty = process.env.VIBEFORGE_PTY || null;
const { flags, words } = parse(rest);
const timeoutMs = flags.timeout ? Math.round(flags.timeout * 60_000) : undefined;

try {
  if (command === "who") {
    const answer = await ask({ op: "who", pty });
    if (answer.error) fail(answer.error);
    // Folders under your home read as ~/…, as a shell prompt shows them.
    const home = process.env.HOME;
    const shown = (folder) => (home && (folder === home || folder.startsWith(`${home}/`)) ? `~${folder.slice(home.length)}` : folder);
    const lines = answer.clis.map((cli) => `${cli.you ? "* " : "  "}${cli.handle.padEnd(14)} ${cli.label}${cli.working ? " (working)" : ""} in ${shown(cli.folder)}`);
    process.stdout.write(`${lines.length ? `CLIs (vibeforge tell <name>):\n${lines.join("\n")}` : "No coding CLIs are running in VibeForge."}\n`);
    if (answer.you) process.stdout.write(`You are ${answer.you}.\n`);
    const TIERS = { fast: "cheap and fast", everyday: "everyday cost", strong: "strong and costly" };
    const agents = answer.agents.map((agent) =>
      [`  ${agent.handle.padEnd(14)} ${agent.engine ?? ""}`, agent.goodAt, TIERS[agent.tier]].filter(Boolean).join(" · "),
    );
    if (agents.length) process.stdout.write(`Agents (vibeforge task <name>):\n${agents.join("\n")}\n`);
    process.exit(0);
  }
  if (command === "apply") {
    if (!words[0]) fail(`apply needs a task id\n\n${USAGE}`, 2);
    const answer = await ask({ op: "apply", pty, task: words[0] });
    if (!answer.ok) fail(answer.error ?? "VibeForge refused that.");
    process.stdout.write(`${answer.files.length ? `Applied ${answer.files.join(", ")}. ` : ""}${answer.note}\n`);
    process.exit(answer.conflicts.length ? 1 : 0);
  }
  if (command !== "tell" && command !== "task") fail(`unknown command ${command}\n\n${USAGE}`, 2);
  const [target, ...message] = words;
  let text = message.join(" ");
  if (text === "-" || (!text && !process.stdin.isTTY)) text = await readStdin();
  if (!target || !text.trim()) fail(`${command} needs a name and a message\n\n${USAGE}`, 2);
  const answer =
    command === "tell"
      ? await ask({ op: "tell", pty, to: target, text, wait: flags.wait, timeoutMs })
      : await ask({ op: "task", pty, agent: target, text, title: flags.title, start: flags.start, wait: flags.wait, timeoutMs });
  if (!answer.ok) fail(answer.error ?? "VibeForge refused that.");
  if (command === "task") {
    process.stdout.write(`${answer.started ? "Started" : "Made"} task "${answer.title}" (${answer.taskId}).${answer.note ? ` ${answer.note}` : ""}\n`);
    if (answer.reply) process.stdout.write(`\n${answer.reply}\n`);
    process.exit(flags.wait && answer.started && !answer.reply ? 3 : 0);
  }
  if (answer.reply) {
    process.stdout.write(`${answer.reply}\n`);
    if (answer.fromScreen) process.stdout.write(`\n(Read from ${answer.to}'s screen.)\n`);
    process.exit(0);
  }
  const said = answer.delivered === "draft" ? `Left in ${answer.to}'s prompt for a person to send.` : answer.delivered === "queued" ? `Queued for ${answer.to}.` : `Sent to ${answer.to}.`;
  process.stdout.write(`${said}${answer.note ? ` ${answer.note}` : ""}\n`);
  process.exit(answer.timedOut ? 3 : 0);
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
