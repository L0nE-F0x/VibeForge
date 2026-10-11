/** The files a diff touches, with lines added and removed, in the order git lists them. */
export function diffFiles(text: string): Array<{ path: string; added: number; removed: number; line: number }> {
  const files: Array<{ path: string; added: number; removed: number; line: number }> = [];
  const lines = text.split("\n");
  for (const [index, line] of lines.entries()) {
    if (line.startsWith("diff --git ")) {
      const path = /^diff --git a\/.+? b\/(.+)$/.exec(line)?.[1] ?? line.slice(11);
      files.push({ path, added: 0, removed: 0, line: index });
    } else if (files.length && line.startsWith("+") && !line.startsWith("+++")) files[files.length - 1].added += 1;
    else if (files.length && line.startsWith("-") && !line.startsWith("---")) files[files.length - 1].removed += 1;
  }
  return files;
}
