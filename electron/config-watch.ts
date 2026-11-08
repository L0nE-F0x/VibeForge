import fs from "node:fs";
import path from "node:path";
import type { Topic } from "../src/core/types.js";

// The config folder is plain files, so it can change outside VibeForge: edited by hand, or by a
// CLI. A change reaches the page as the topics it touches, as VibeForge's own saves do.

/** The topics a change to `file` (relative to the config folder) touches; none for layouts or temp files. */
export function configTopics(file: string): Topic[] {
  const first = file.split(path.sep)[0];
  if (file.endsWith(".tmp") || first === "layouts") return [];
  if (first === "agents") return ["agents", "routines", "tasks"];
  if (first === "skills") return ["skills", "agents"];
  if (first === "routines") return ["routines"];
  if (first === "tasks") return ["tasks"];
  if (file === "engines.json") return ["engines", "agents", "routines", "tasks"];
  if (file === "settings.json") return ["settings"];
  if (file === "workspaces.json") return ["workspaces"];
  return [];
}

/** Watches the config folder and hands on the topics changed, once changes pause for 250 ms. Returns a stop. */
export function watchConfig(configRoot: string, changed: (topics: Topic[]) => void): () => void {
  const pending = new Set<Topic>();
  let timer: NodeJS.Timeout | null = null;
  let watcher: fs.FSWatcher | null = null;
  try {
    watcher = fs.watch(configRoot, { recursive: true, persistent: false }, (_type, file) => {
      if (!file) return;
      for (const topic of configTopics(String(file))) pending.add(topic);
      if (!pending.size) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        const topics = [...pending];
        pending.clear();
        changed(topics);
      }, 250);
    });
  } catch {
    watcher = null;
  }
  return () => {
    if (timer) clearTimeout(timer);
    watcher?.close();
  };
}
