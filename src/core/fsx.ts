import fs from "node:fs";
import path from "node:path";

/** Write through a temp file and rename, so a crash never leaves half a YAML file behind. */
export function writeFileAtomic(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`);
  fs.writeFileSync(temp, text);
  fs.renameSync(temp, file);
}

export function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

/**
 * Write a JSON file. One that is there and doesn't parse (a hand edit half done) is moved aside to
 * `<name>.broken` first, so saving from the app never loses what its author wrote.
 */
export function writeJson(file: string, value: unknown): void {
  setAsideBroken(file);
  writeFileAtomic(file, `${JSON.stringify(value, null, 2)}\n`);
}

function setAsideBroken(file: string): void {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return;
  }
  if (!text.trim()) return;
  try {
    JSON.parse(text);
  } catch {
    const aside = fs.existsSync(`${file}.broken`) ? `${file}.broken-${Date.now()}` : `${file}.broken`;
    fs.renameSync(file, aside);
  }
}

export function readText(file: string): string {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

export function isDirectory(dir: string): boolean {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}
