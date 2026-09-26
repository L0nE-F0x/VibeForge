// What a dictated sentence is for. Most are words for the box or terminal they land in. Two
// shapes do something else:
//   "Atlas, add tests for the scheduler"   → a message for the agent named Atlas
//   "Forge, new task fix the login page"   → a command for VibeForge itself
// Commands need the wake word ("Forge" or "VibeForge") first, so an ordinary prompt that happens
// to say "stop" is never taken for one. There is no model involved: a small fixed grammar, in English.

export const VIEWS = ["home", "agents", "code", "chat", "tasks", "routines", "skills", "runs", "settings"] as const;
export type ViewWord = (typeof VIEWS)[number];

export type Command =
  | { type: "newTask"; title: string; agentId: string | null }
  | { type: "runRoutine"; routineId: string }
  | { type: "open"; view: ViewWord }
  /** Send what is waiting in the box or terminal (review mode, hands-free). */
  | { type: "send" }
  /** Empty the box, or the terminal's input line. */
  | { type: "clear" }
  | { type: "stop" }
  | { type: "continue" }
  | { type: "stopListening" }
  | { type: "unknown"; text: string };

export type Utterance = { kind: "text"; text: string } | { kind: "agent"; agentId: string; text: string } | { kind: "command"; command: Command };

interface Named {
  id: string;
  name: string;
}

/** Lower case letters, digits and single spaces. */
function squash(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function capitalize(text: string): string {
  return text ? text[0].toUpperCase() + text.slice(1) : text;
}

function findByName<T extends Named>(items: readonly T[], spoken: string): T | null {
  const said = squash(spoken);
  if (!said) return null;
  return items.find((item) => squash(item.name) === said) ?? items.find((item) => squash(item.name).replace(/ /g, "") === said.replace(/ /g, "")) ?? null;
}

const WAKE = /^\s*(?:hey\s+|ok(?:ay)?\s+)?(?:vibe\s*forge|forge)\s*[,.:;!?-]?\s*/i;

function parseCommand(rest: string, agents: readonly Named[], routines: readonly Named[]): Command {
  const said = rest.replace(/[.!?]+$/, "").trim();
  const words = squash(said);
  if (/^(stop listening|goodbye|good bye|bye|that s all|that is all|we re done|we are done)$/.test(words)) return { type: "stopListening" };
  if (/^(send|send it|submit|submit it|enter|go ahead|press enter)$/.test(words)) return { type: "send" };
  if (/^(clear|clear it|clear that|scratch that|delete that|start over)$/.test(words)) return { type: "clear" };
  if (/^(stop|stop it|stop that|cancel|interrupt|stop the run|halt)$/.test(words)) return { type: "stop" };
  if (/^(continue|keep going|carry on|resume|go on)$/.test(words)) return { type: "continue" };

  const open = /^(?:go to|open|show(?: me)?|switch to)\s+(?:the\s+)?(\w+)(?:\s+(?:view|page|tab))?$/.exec(words);
  if (open) {
    const view = VIEWS.find((name) => name === open[1] || `${name}s` === open[1] || name === `${open[1]}s`);
    if (view) return { type: "open", view };
  }

  // "new task for Atlas: fix the login page", "create a task to fix the login page"
  const task = /^(?:new|create|add|make)\s+(?:a\s+)?task\b[\s,.:;-]*(.*)$/i.exec(said);
  if (task) {
    let body = task[1].trim();
    let agentId: string | null = null;
    const forAgent = /^for\s+(.+?)\s*[,:;-]\s*(.+)$/i.exec(body);
    if (forAgent) {
      const agent = findByName(agents, forAgent[1]);
      if (agent) {
        agentId = agent.id;
        body = forAgent[2];
      }
    }
    body = body.replace(/^(?:to|that|called|named)\s+/i, "").trim();
    if (body) return { type: "newTask", title: capitalize(body), agentId };
  }

  // "run the nightly review routine", "run routine nightly review"
  const run = /^(?:run|start|fire|kick off)\s+(?:the\s+)?(?:routine\s+)?(.+?)(?:\s+routine)?(?:\s+now)?$/.exec(words);
  if (run) {
    const routine = findByName(routines, run[1]);
    if (routine) return { type: "runRoutine", routineId: routine.id };
  }
  return { type: "unknown", text: said };
}

export function parseUtterance(text: string, context: { agents: readonly Named[]; routines: readonly Named[] }): Utterance {
  const wake = WAKE.exec(text);
  if (wake) {
    // "Forge, …" is a command. Without the pause ("forge new task …") only when the rest is one,
    // so "Forge the sword" stays words.
    const command = parseCommand(text.slice(wake[0].length), context.agents, context.routines);
    const paused = /[,.:;!?-]\s*$/.test(wake[0]) || !text.slice(wake[0].length).trim();
    if (paused || command.type !== "unknown") return { kind: "command", command };
  }

  // "Atlas, …" or "Atlas: …" (whisper writes the pause as a comma), or "tell Atlas to …" / "ask Atlas to …".
  const vocative = /^\s*(?:hey\s+)?([^,:;.!?]{1,40}?)\s*[,:]\s+(.+)$/is.exec(text);
  if (vocative) {
    const agent = findByName(context.agents, vocative[1]);
    if (agent) return { kind: "agent", agentId: agent.id, text: capitalize(vocative[2].trim()) };
  }
  const indirect = /^\s*(?:tell|ask)\s+(.+)$/is.exec(text);
  if (indirect) {
    // The name is the first few words that make an agent's name: "tell Atlas to fix", "ask Code Review to look".
    const tokens = indirect[1].split(/\s+/);
    for (let n = 1; n <= Math.min(5, tokens.length - 1); n++) {
      const agent = findByName(context.agents, tokens.slice(0, n).join(" "));
      if (!agent) continue;
      const rest = tokens.slice(n).join(" ").replace(/^to\s+/i, "").trim();
      if (rest) return { kind: "agent", agentId: agent.id, text: capitalize(rest) };
    }
  }
  return { kind: "text", text };
}
