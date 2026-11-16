// What reaches a terminal from the keyboard, told apart from what the terminal reports on its own:
// shared by the core (agents talking) and the window (dictated words waiting for Enter).

/**
 * Escape sequences: all a terminal ever writes back on its own. Focus in/out, mouse reports (X10
 * first, its three bytes can be anything), and its answers to a CLI's questions: cursor position,
 * device attributes, colours, its name (CSI, OSC, DCS and the other string sequences, SS3 and the
 * two-byte ones). Arrows, F-keys and a bare Esc are these too, so they aren't a person stepping in;
 * a letter, Backspace or Enter is.
 */
const ESCAPES = /\x1b\[M[\s\S]{3}|\x1b\[[0-?]*[ -/]*[@-~]|\x1b[\]P_^X][\s\S]*?(?:\x07|\x1b\\|$)|\x1bO[\s\S]|\x1b[ -/]*[0-~]/g;

/**
 * What a person typed: `data` less what a terminal reports on its own. A terminal reports focus
 * and the mouse as input too (Claude Code asks for focus events), and answers what a CLI asks it
 * (where the cursor is, what it can do): clicking a pane, or a CLI drawing its screen, isn't a
 * person stepping into the conversation. Empty when that's all it was.
 */
export function typedIn(data: string): string {
  return data.replace(ESCAPES, "").replace(/\x1b/g, "");
}
