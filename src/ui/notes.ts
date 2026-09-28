// Release notes, shown in the update dialog. GitHub keeps them as Markdown; the dialog draws the
// parts they use (paragraphs, "- " lists, "#" headings, and **bold** through Rich), never as HTML.

export type NotesBlock = { kind: "head" | "para"; text: string } | { kind: "list"; items: string[] };

/** Blocks from Markdown. A link keeps its text; a wrapped line joins the item or paragraph above it. */
export function notesBlocks(markdown: string): NotesBlock[] {
  const blocks: NotesBlock[] = [];
  let open = false;
  for (const raw of markdown.replace(/\r\n?/g, "\n").split("\n")) {
    const line = raw.replace(/\[([^\]]+)\]\([^)\s]+\)/g, "$1");
    const item = /^\s*[-*+]\s+(.*)$/.exec(line);
    const head = /^#{1,6}\s+(.*)$/.exec(line);
    const last = blocks[blocks.length - 1];
    if (!line.trim()) open = false;
    else if (head) {
      blocks.push({ kind: "head", text: head[1].trim() });
      open = false;
    } else if (item) {
      if (open && last?.kind === "list") last.items.push(item[1].trim());
      else blocks.push({ kind: "list", items: [item[1].trim()] });
      open = true;
    } else if (open && last?.kind === "list") last.items[last.items.length - 1] += ` ${line.trim()}`;
    else if (open && last?.kind === "para") last.text += ` ${line.trim()}`;
    else {
      blocks.push({ kind: "para", text: line.trim() });
      open = true;
    }
  }
  return blocks;
}
