import type { Idea, Project, Settings, Ambition } from "@vibeforge/shared";
import { extJson } from "./util.ts";

/* ---------------- diversity engine ---------------- */
const LENSES = ["developer tool", "productivity & workflow app", "data dashboard / analytics", "notes & knowledge base (PKM)",
  "project & task planner", "creative / design tool", "writing & editing tool", "learning / study app", "budgeting & finance tool",
  "diagramming / whiteboard", "code playground / sandbox", "media organizer", "scheduling / calendar tool", "form / survey builder",
  "habit & health tracker", "research & reading tool", "music / audio workstation", "monitoring / status board", "CRM / contacts manager"];
const AUDIENCES = ["indie developers", "writers & researchers", "designers", "data analysts", "students", "small teams",
  "freelancers", "musicians", "traders & investors", "language learners", "tabletop game masters", "open-source maintainers",
  "content creators", "teachers", "product managers", "scientists", "job seekers", "home cooks", "DJs", "podcasters"];
const QUALITIES = ["keyboard-first and fast", "works fully offline with local data", "handles large datasets smoothly",
  "dense, pro-grade UI", "opinionated — does one job extremely well", "imports/exports real file formats",
  "powerful yet learnable in a minute", "delightful, polished interactions", "real-time feel from local state"];
const pick = <T,>(a: T[]): T => a[Math.floor(Math.random() * a.length)];

const DEPTH_DESC: Record<string, string> = {
  S: "a sharp, single-purpose utility — one job done extremely well, ~1 main view. Still a real, polished app, just tightly scoped.",
  M: "a multi-feature app with a few views and a real data model — a genuinely useful product someone returns to.",
  L: "a deep, ambitious product: several substantial features, multiple views, a rich data model and interactions — the kind of thing that could be a real SaaS.",
};

export interface Prompt { system: string; user: string }

/* ---------------- ideation ---------------- */
export function buildIdeationPrompt(settings: Settings, avoidTitles: string[]): Prompt {
  const count = settings.batch;
  const grounded = !!settings.grounding?.ideation;
  const system = [
    "You are the Creative Director of VIBE FORGE, a studio that designs REAL, genuinely useful web applications — not toys, demos, or single-file experiments.",
    "Invent original app concepts that a skilled developer working with an AI coding assistant can realistically build: polished, multi-file apps on a modern stack. Prefer client-side / local-first designs (browser persistence); a simple backend is acceptable only when the idea genuinely needs one.",
    "The bar: something a real person would open repeatedly and find genuinely useful or compelling — an app you'd bookmark, not a 30-second novelty.",
    "Each idea must be (1) genuinely novel — a different CORE CONCEPT from the others and from everything on the AVOID list, not just a renamed variant of the same thing, (2) a substantial but focused product (not a kitchen sink), (3) buildable in a focused session by a strong coding agent.",
    "Avoid: single-file toys, generative-art / screensaver / particle sketches, and generic clones (todo, weather, calculator, plain notes). Think product, not party trick.",
  ].join("\n");

  // When grounding is on we DISCOVER ideas from the live web (real gaps / new launches)
  // instead of leaning on the internal seed lists — that's what keeps batches fresh and distinct.
  const discovery = [
    "RESEARCH FIRST — you have a live web_search tool. Actually run several searches before you invent anything.",
    "Hunt for what's genuinely MISSING or newly possible right now, for example:",
    "  • Unmet demand people state out loud — Reddit threads (r/SideProject, r/somebodymakethis, r/webdev, niche subreddits), forum posts, tweets where someone says \"I wish there was an app that…\" or \"why does no tool do…\".",
    "  • Fresh launches and their gaps — Product Hunt, \"Show HN\" on Hacker News, indie-hacker communities: what just shipped, and what people say it's still missing.",
    "  • New capabilities — recent APIs, browser features, or model abilities that make a previously-hard app newly buildable.",
    "Turn those real signals into apps that fill a concrete gap. Each pitch should reflect the actual unmet need you found. Favor fresh, of-the-moment concepts over timeless clichés, and prefer underserved niches over crowded categories.",
  ];

  const seedList = Array.from({ length: Math.min(count, 4) }, () => `a ${pick(LENSES)} for ${pick(AUDIENCES)} — ${pick(QUALITIES)}`);
  const seeds = [
    "Creative seeds for variety this batch (interpret loosely; do NOT name them literally):",
    ...seedList.map((s) => "  • " + s),
  ];

  const user = [
    `Generate ${count} app ideas as a JSON array. Each item:`,
    '{ "title": string (<=4 words), "pitch": string (2-3 sentences: who it\'s for, the problem, and why it\'s genuinely useful), "tags": string[] (2-4), "lens": string (app category), "ambition": "S" | "M" | "L" (S=sharp single-purpose tool, M=multi-feature app, L=substantial multi-view app) }',
    "Respond with ONLY the JSON array. No prose, no code fences.",
    settings.depth && settings.depth !== "mixed"
      ? `\nDEPTH — make ALL ${count} ideas at this scope: ${DEPTH_DESC[settings.depth]} Set every idea's "ambition" to "${settings.depth}".`
      : "",
    "",
    ...(grounded ? discovery : seeds),
    settings.steer ? `\nHuman steering to honor: ${settings.steer}` : "",
    avoidTitles.length
      ? "\nAVOID — do NOT repeat or closely resemble any of these existing concepts. Pick genuinely different problems and categories:\n" + avoidTitles.map((t) => "  – " + t).join("\n")
      : "",
  ].join("\n");
  return { system, user };
}

export function parseIdeas(text: string): Idea[] {
  const arr = extJson<unknown[]>(text, "[");
  const out: Idea[] = [];
  for (const raw of arr) {
    const it = raw as Record<string, unknown>;
    if (!it || typeof it.title !== "string" || !it.title.trim()) continue;
    out.push({
      title: it.title.trim(),
      pitch: String(it.pitch || "").trim(),
      tags: Array.isArray(it.tags) ? it.tags.slice(0, 4).map(String) : [],
      lens: String(it.lens || ""),
      ambition: (["S", "M", "L"].includes(it.ambition as string) ? it.ambition : "M") as Ambition,
    });
  }
  return out;
}

/* ---------------- spec ---------------- */
export function buildSpecPrompt(p: Project): Prompt {
  const scope = ({
    S: "a sharp, single-purpose tool (tightly scoped, ~1 main view)",
    M: "a multi-feature app (several views, a real data model)",
    L: "an ambitious, deep product (multiple substantial features and views, a rich data model)",
  } as Record<string, string>)[p.ambition] || "a real, multi-feature app";
  const system = [
    "You are the Lead Product Engineer at VIBE FORGE. Turn an app idea into a precise, build-ready spec that the user will hand to their AI coding assistant (Claude Code, Cursor, Codex…).",
    "The spec must let a strong coding agent build the complete app in one focused session with no further questions: name the stack, libraries, architecture, data model, and full feature set. Be concrete and decisive — make the product and visual calls yourself.",
    "Default to a modern client-side stack (e.g. Vite + React + TypeScript with local persistence via IndexedDB/localStorage); specify a simple backend only if the idea genuinely needs one.",
  ].join("\n");
  const user = [
    `Idea — Title: ${p.title} | Pitch: ${p.pitch} | Tags: ${(p.tags || []).join(", ")}`,
    `Target scope: ${scope}.`,
    "",
    "Write the spec in Markdown with exactly these sections, ambitious yet implementable in one focused pass:",
    `# ${p.title}`,
    "## Concept & Target User  (who it's for, the problem, the core value)",
    "## Feature Set  (the real, multi-feature scope — primary features and the views/screens they live in)",
    "## Tech Stack  (framework, language, key libraries: state, routing, UI, storage, charts, etc.)",
    "## Architecture & File Structure  (components/modules and their responsibilities)",
    "## Data Model & Persistence  (entities, shapes, storage approach; seed/sample data)",
    "## UX & Visual Direction  (layout, navigation, palette, typography, density, motion, empty/loading states)",
    "## Getting Started  (how to scaffold and run: commands, suggested npm scripts)",
    "## Acceptance Criteria  (a checklist proving the key features actually work)",
    "No preamble.",
  ].join("\n");
  return { system, user };
}

/* ---------------- refine ---------------- */
export function buildRefinePrompt(p: Project, feedback: string): Prompt {
  const system = [
    "You are the Lead Product Engineer at VIBE FORGE revising a build spec.",
    "Apply the requested changes faithfully, keep everything else intact, and return the COMPLETE revised spec in the same Markdown structure. No preamble, no commentary — just the full spec.",
  ].join("\n");
  const user = [
    `App: ${p.title}`,
    "",
    "--- CURRENT SPEC ---",
    p.spec,
    "",
    "--- REQUESTED CHANGES ---",
    feedback,
    "--- END ---",
    "",
    "Return the complete revised spec now.",
  ].join("\n");
  return { system, user };
}
