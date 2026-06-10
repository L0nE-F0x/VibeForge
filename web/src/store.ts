import { create } from "zustand";
import { persist } from "zustand/middleware";
import { defaultSettings, PROVIDERS } from "@vibeforge/shared";
import type { Project, Settings, Depth } from "@vibeforge/shared";
import { runStep } from "./lib/engine.ts";
import { buildIdeationPrompt, buildBrainstormPrompt, buildSpecPrompt, buildRefinePrompt, parseIdeas, parseAngles, randomSparks } from "./lib/pipeline.ts";
import { uid, slugify } from "./lib/util.ts";

export interface Toast { id: string; kind: string; title: string; body?: string }
export type StreamFilter = "all" | "new" | "specs" | "exported";

const FILTER_MATCH: Record<StreamFilter, (p: Project) => boolean> = {
  all: () => true,
  new: (p) => p.status === "idea" || p.status === "error",
  specs: (p) => p.status === "specing" || p.status === "spec",
  exported: (p) => p.status === "exported",
};
export const matchesFilter = (p: Project, f: StreamFilter) => FILTER_MATCH[f](p);

interface State {
  projects: Project[];
  ledgerTitles: string[];
  settings: Settings;
  selectedId: string | null;
  filter: StreamFilter;
  generating: boolean;
  view: "landing" | "studio";
  toasts: Toast[];

  generateIdeas: () => Promise<void>;
  genSpec: (id: string) => Promise<void>;
  refineSpec: (id: string, feedback: string) => Promise<void>;
  undoRefine: (id: string) => void;
  saveSpec: (id: string, text: string) => void;
  markExported: (id: string) => void;
  discard: (id: string) => void;
  clearIdeas: () => void;
  select: (id: string | null) => void;
  setFilter: (f: StreamFilter) => void;
  setView: (v: "landing" | "studio") => void;
  setDepth: (d: Depth) => void;
  saveSettings: (patch: Partial<Settings>) => void;
  toast: (t: Omit<Toast, "id">) => void;
  dismiss: (id: string) => void;
}

function mergeSettings(saved: unknown): Settings {
  const d = defaultSettings();
  const s = (saved ?? {}) as Partial<Settings>;
  const merged: Settings = {
    ...d,
    ...s,
    grounding: { ...d.grounding, ...(s.grounding || {}) },
    providers: { ...d.providers },
  };
  if (s.providers) {
    for (const id of Object.keys(d.providers) as (keyof Settings["providers"])[]) {
      merged.providers[id] = { ...d.providers[id], ...(s.providers[id] || {}) };
    }
  }
  // Reset any provider id that no longer exists (e.g. the removed "demo").
  const valid = new Set(PROVIDERS.map((p) => p.id));
  if (!valid.has(merged.ideationProvider)) merged.ideationProvider = "anthropic";
  if (!valid.has(merged.specProvider)) merged.specProvider = "anthropic";
  return merged;
}

export const useStore = create<State>()(
  persist(
    (set, get) => {
      const patch = (id: string, partial: Partial<Project>) =>
        set((s) => ({
          projects: s.projects.map((p) => (p.id === id ? { ...p, ...partial, updatedAt: Date.now() } : p)),
        }));

      const hasTitle = (t: string) => {
        const lc = t.toLowerCase();
        return get().ledgerTitles.some((x) => x.toLowerCase() === lc) ||
          get().projects.some((p) => p.title.toLowerCase() === lc);
      };

      const uniqueSlug = (base: string) => {
        const used = new Set(get().projects.map((p) => p.slug));
        const s = slugify(base);
        let out = s, n = 1;
        while (used.has(out)) out = `${s}-${++n}`;
        return out;
      };

      return {
        projects: [],
        ledgerTitles: [],
        settings: defaultSettings(),
        selectedId: null,
        filter: "all",
        generating: false,
        view: "landing",
        toasts: [],

        generateIdeas: async () => {
          if (get().generating) return;
          set({ generating: true });
          try {
            const settings = get().settings;
            const avoid = get().ledgerTitles.slice(-120);

            // Offline path (no web search): let the model brainstorm distinct angles first,
            // seeded by a few random real-world sparks, then ideate from those. The web path
            // already draws novelty from live search, so it skips this extra call.
            let seeds: string[] = [];
            if (!settings.grounding.ideation) {
              const sparks = randomSparks(Math.min(settings.batch, 4));
              try {
                const bp = buildBrainstormPrompt(settings, sparks, avoid);
                const br = await runStep(settings, "ideation", { ...bp, maxTokens: 700, temperature: 1, search: false });
                seeds = parseAngles(br.text);
              } catch {
                seeds = sparks; // brainstorm failed — fall back to the raw sparks
              }
            }

            const prompt = buildIdeationPrompt(settings, avoid, seeds);
            const r = await runStep(settings, "ideation", {
              ...prompt, maxTokens: 2000, temperature: 1, search: settings.grounding.ideation,
            });
            const ideas = parseIdeas(r.text);
            const added: Project[] = [];
            for (const it of ideas) {
              if (hasTitle(it.title)) continue;
              const now = Date.now();
              added.push({
                ...it,
                id: uid(),
                slug: uniqueSlug(it.title),
                status: "idea",
                spec: "",
                sources: r.citations.slice(0, 8),
                providerUsed: r.provider,
                createdAt: now,
                updatedAt: now,
              });
            }
            set((s) => ({
              projects: [...added, ...s.projects],
              ledgerTitles: [...s.ledgerTitles, ...added.map((p) => p.title)].slice(-300),
            }));
            get().toast({
              kind: "good",
              title: `${added.length} idea${added.length === 1 ? "" : "s"} minted`,
              body: added.length ? undefined : "All duplicates — try again.",
            });
            if (added.length && !get().selectedId) set({ selectedId: added[0].id });
          } catch (e) {
            get().toast({ kind: "bad", title: "Ideation failed", body: (e as Error).message });
          } finally {
            set({ generating: false });
          }
        },

        genSpec: async (id) => {
          const p = get().projects.find((x) => x.id === id);
          if (!p || p.status === "specing") return;
          patch(id, { status: "specing", statusMsg: "Drafting spec…", error: "" });
          try {
            const settings = get().settings;
            const prompt = buildSpecPrompt(p);
            const r = await runStep(settings, "spec", {
              ...prompt, maxTokens: 3000, temperature: 0.7, search: settings.grounding.spec,
            });
            const sources = r.citations.length
              ? [...new Set([...(p.sources || []), ...r.citations])].slice(0, 10)
              : p.sources;
            patch(id, { spec: r.text.trim(), sources, status: "spec", statusMsg: "" });
          } catch (e) {
            patch(id, { status: "error", error: (e as Error).message, statusMsg: "" });
            get().toast({ kind: "bad", title: "Spec failed", body: (e as Error).message });
          }
        },

        refineSpec: async (id, feedback) => {
          const p = get().projects.find((x) => x.id === id);
          if (!p || !p.spec || p.status === "specing") return;
          const before = p.spec;
          patch(id, { status: "specing", statusMsg: "Refining spec…", error: "" });
          try {
            const settings = get().settings;
            const prompt = buildRefinePrompt(p, feedback);
            const r = await runStep(settings, "spec", { ...prompt, maxTokens: 3000, temperature: 0.5 });
            patch(id, { spec: r.text.trim(), prevSpec: before, status: "spec", statusMsg: "" });
            get().toast({ kind: "steel", title: "Spec refined", body: "Undo available." });
          } catch (e) {
            patch(id, { status: "spec", statusMsg: "", error: "" });
            get().toast({ kind: "bad", title: "Refine failed", body: (e as Error).message });
          }
        },

        undoRefine: (id) => {
          const p = get().projects.find((x) => x.id === id);
          if (!p?.prevSpec) return;
          patch(id, { spec: p.prevSpec, prevSpec: p.spec });
        },

        saveSpec: (id, text) => {
          const p = get().projects.find((x) => x.id === id);
          if (p && text !== p.spec) patch(id, { spec: text });
        },

        markExported: (id) => {
          const p = get().projects.find((x) => x.id === id);
          if (p && p.status !== "exported") patch(id, { status: "exported", exportedAt: Date.now() });
        },

        discard: (id) => {
          const p = get().projects.find((x) => x.id === id);
          if (!p) return;
          if ((p.status === "spec" || p.status === "exported") &&
            !window.confirm(`Discard "${p.title}" and its spec?`)) return;
          set((s) => ({
            projects: s.projects.filter((x) => x.id !== id),
            selectedId: s.selectedId === id ? null : s.selectedId,
          }));
        },

        clearIdeas: () => {
          const n = get().projects.length;
          if (!n) return;
          if (!window.confirm(`Delete all ${n} idea${n === 1 ? "" : "s"} and their specs? This can't be undone.`)) return;
          // Keep ledgerTitles so future batches still avoid repeating what you've already seen.
          set({ projects: [], selectedId: null });
          get().toast({ kind: "steel", title: `Cleared ${n} idea${n === 1 ? "" : "s"}` });
        },

        select: (id) => set({ selectedId: id }),
        setFilter: (f) => set({ filter: f }),
        setView: (v) => set({ view: v }),
        setDepth: (d) => set((s) => ({ settings: { ...s.settings, depth: d } })),
        saveSettings: (patchIn) =>
          set((s) => ({ settings: mergeSettings({ ...s.settings, ...patchIn }) })),

        toast: (t) => {
          const id = Math.random().toString(36).slice(2);
          set((s) => ({ toasts: [...s.toasts, { ...t, id }] }));
          setTimeout(() => get().dismiss(id), 4500);
        },
        dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((x) => x.id !== id) })),
      };
    },
    {
      name: "vibeforge.v3",
      partialize: (s) => ({
        projects: s.projects.map((p) => (p.status === "specing" ? { ...p, status: "spec" as const, statusMsg: "" } : p)),
        ledgerTitles: s.ledgerTitles,
        settings: s.settings,
        selectedId: s.selectedId,
        view: s.view,
      }),
      merge: (saved, current) => {
        const raw = (saved ?? {}) as Partial<State>;
        const projects = (raw.projects || [])
          .filter((p) => (p.providerUsed as string) !== "demo") // drop old demo-generated ideas
          .map((p) => (p.status === "specing" ? { ...p, status: p.spec ? "spec" : "idea", statusMsg: "" } : p));
        const selectedId = projects.some((p) => p.id === raw.selectedId) ? raw.selectedId! : null;
        return {
          ...current,
          projects,
          ledgerTitles: raw.ledgerTitles || [],
          settings: mergeSettings(raw.settings),
          selectedId,
          view: raw.view ?? "landing",
        };
      },
    },
  ),
);
