/** Tiny markdown → HTML renderer for spec previews (headings, lists, bold, code). */
export function md(src: string): string {
  const esc = (s: string) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]!));
  const inline = (t: string) =>
    esc(t).replace(/`([^`]+)`/g, "<code>$1</code>").replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>");
  const lines = (src || "").split(/\r?\n/);
  let out = "", inList = false, inCode = false;
  for (const ln of lines) {
    if (/^\s*```/.test(ln)) {
      if (inList) { out += "</ul>"; inList = false; }
      out += inCode ? "</code></pre>" : "<pre><code>";
      inCode = !inCode;
      continue;
    }
    if (inCode) { out += esc(ln) + "\n"; continue; }
    if (/^\s*[-*]\s+/.test(ln)) {
      if (!inList) { out += "<ul>"; inList = true; }
      out += "<li>" + inline(ln.replace(/^\s*[-*]\s+/, "")) + "</li>";
      continue;
    }
    if (inList) { out += "</ul>"; inList = false; }
    if (/^#{1,6}\s/.test(ln)) {
      const lv = Math.min(ln.match(/^#+/)![0].length, 3);
      out += `<h${lv}>` + inline(ln.replace(/^#+\s/, "")) + `</h${lv}>`;
    } else if (ln.trim() === "") {
      continue;
    } else {
      out += "<p>" + inline(ln) + "</p>";
    }
  }
  if (inList) out += "</ul>";
  if (inCode) out += "</code></pre>";
  return out;
}
