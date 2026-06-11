import type { Idea, Project, Settings, Ambition } from "@vibeforge/shared";
import { extJson } from "./util.ts";

/* ---------------- spark vocabulary ----------------
 * Random real-world "worlds" and life-frictions used purely as ENTROPY to break
 * the model's habit of collapsing onto the same handful of default ideas. These
 * are deliberately NOT app categories — they seed a free-roaming brainstorm; they
 * do not dictate the product. Used only on the offline (no web search) path. */
const SPARKS = [
  // unexpected hobbies / niches / trades
  "beekeeping", "urban foraging", "home coffee roasting", "sourdough & fermentation",
  "aquascaping", "model railways", "amateur (ham) radio", "vintage synth repair",
  "competitive bouldering", "freediving", "tide pooling", "birdwatching",
  "geocaching", "thrifting & reselling", "drone racing", "calligraphy & hand-lettering",
  "bookbinding", "allotment & community gardening", "mushroom foraging", "astrophotography",
  "vinyl record collecting", "tabletop wargaming", "long-distance thru-hiking", "sea kayaking",
  "dog agility training", "backyard chickens", "home cheesemaking", "perfumery & scent blending",
  "metal detecting", "amateur astronomy", "classic car restoration", "quilting & textile craft",
  "competitive debate", "urban sketching", "rock & mineral collecting", "home brewing & kombucha",
  "orienteering", "miniature painting", "open-mic stand-up comedy", "community theatre",
  "genealogy & family history", "stamp & coin collecting", "wild swimming", "bushcraft & knife sharpening",
  "street-food vending", "busking & street performance", "herbalism & apothecary", "vintage watch servicing",
  "paragliding", "seed saving & heirloom plants", "competitive jigsaw puzzling", "sport lock-picking",
  // real-life frictions, not hobbies
  "renting & moving to a new city", "caring for an aging parent", "managing a chronic condition",
  "freelance feast-or-famine cashflow", "co-parenting logistics", "planning a low-budget wedding",
  "running a small Etsy/maker shop", "shared-house chores & bills", "job hunting after a layoff",
  "settling an estate after a death", "training for a first marathon", "learning an instrument as an adult",
];

/** A few DISTINCT random real-world sparks — the entropy source for the offline path. */
export function randomSparks(n: number): string[] {
  const pool = [...SPARKS];
  const out: string[] = [];
  for (let i = 0; i < n && pool.length; i++) {
    out.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]);
  }
  return out;
}

const DEPTH_DESC: Record<string, string> = {
  S: "a sharp, single-purpose utility — one job done extremely well, ~1 main view. Still a real, polished app, just tightly scoped.",
  M: "a multi-feature app with a few views and a real data model — a genuinely useful product someone returns to.",
  L: "a deep, ambitious product: several substantial features, multiple views, a rich data model and interactions — the kind of thing that could be a real SaaS.",
};

export interface Prompt { system: string; user: string }

/* ---------------- brainstorm (offline novelty engine) ----------------
 * One cheap call where the MODEL itself generates a spread of distinct angles,
 * nudged outward by a few random real-world sparks. Its output seeds ideation,
 * so novelty emerges from the model — the sparks are only there to scatter the
 * starting point. Runs only when live web search is off. */
export function buildBrainstormPrompt(settings: Settings, sparks: string[], avoidTitles: string[]): Prompt {
  const count = settings.batch;
  const system = [
    "You are a relentlessly original product scout for VIBE FORGE.",
    "Your job: surface surprising, specific problems worth building a web app around — especially in corners of life most app makers overlook. Concrete and unexpected beats safe and generic.",
  ].join("\n");
  const user = [
    `Brainstorm ${count} DISTINCT angles for genuinely useful, novel web apps.`,
    `Each angle = a specific person or situation + a real friction or unmet need they have. Keep the ${count} angles far apart from one another — different worlds, different problems, not variations on a theme.`,
    sparks.length
      ? "A few random real-world worlds to spark from — riff on them, wander to neighbours, or leap somewhere else entirely; do NOT feel confined to them, and do NOT just bolt a generic tracker onto each:\n" + sparks.map((s) => "  • " + s).join("\n")
      : "",
    settings.steer ? `\nHuman steering to honor: ${settings.steer}` : "",
    avoidTitles.length ? "\nStay well away from anything resembling these existing concepts:\n" + avoidTitles.map((t) => "  – " + t).join("\n") : "",
    "",
    `Respond with ONLY a JSON array of ${count} short strings — one angle per string, one sentence each. No prose, no code fences.`,
  ].join("\n");
  return { system, user };
}

export function parseAngles(text: string): string[] {
  try {
    return extJson<unknown[]>(text, "[").map((x) => String(x).trim()).filter(Boolean).slice(0, 12);
  } catch {
    return [];
  }
}

/* ---------------- ideation ----------------
 * `seeds` are the model-brainstormed angles (offline path). When grounding is on
 * they're ignored — the live web discovery block drives novelty instead. */
export function buildIdeationPrompt(settings: Settings, avoidTitles: string[], seeds: string[] = []): Prompt {
  if (settings.depth === "game") return buildGameIdeationPrompt(settings, avoidTitles);
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

  // Offline path: build from the model's brainstormed angles (preferred); if none were
  // supplied, fall back to raw random sparks. Either way the app concept is free to emerge.
  const seedSource = seeds.length ? seeds : randomSparks(Math.min(count, 4));
  const seedBlock = [
    seeds.length
      ? "Build one app idea from EACH of these angles, in order — keep them as distinct from each other as they are here:"
      : "Random real-world sparks for this batch — riff on them and let the actual app concept emerge; do NOT name them literally or just bolt a generic tracker onto each:",
    ...seedSource.map((s) => "  • " + s),
  ];

  const user = [
    `Generate ${count} app ideas as a JSON array. Each item:`,
    '{ "title": string (<=4 words), "pitch": string (2-3 sentences: who it\'s for, the problem, and why it\'s genuinely useful), "tags": string[] (2-4), "lens": string (app category), "ambition": "S" | "M" | "L" (S=sharp single-purpose tool, M=multi-feature app, L=substantial multi-view app) }',
    "Respond with ONLY the JSON array. No prose, no code fences.",
    settings.depth && settings.depth !== "mixed"
      ? `\nDEPTH — make ALL ${count} ideas at this scope: ${DEPTH_DESC[settings.depth]} Set every idea's "ambition" to "${settings.depth}".`
      : "",
    "",
    ...(grounded ? discovery : seedBlock),
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

/* ---------------- games ----------------
 * "Games" depth is a different KIND of batch, not a scope: graphics-rich browser
 * games on a real-time WebGL stack, steered hard toward Three.js + custom GLSL
 * shaders so the resulting specs put rendering front and centre. The app-oriented
 * spark brainstorm is skipped; with grounding ON, a game-specific discovery block
 * researches the live web-game scene instead. */
export function buildGameIdeationPrompt(settings: Settings, avoidTitles: string[]): Prompt {
  const count = settings.batch;
  const grounded = !!settings.grounding?.ideation;
  const system = [
    "You are the Creative Director of VIBE FORGE GAMES, a studio that ships original, visually striking games that run in the browser on modern real-time graphics tech.",
    "Invent games a skilled developer can build with an AI coding assistant on a Three.js / WebGL (or WebGPU) stack: real-time 3D or shader-driven 2D with a genuine core gameplay loop — not screensavers, particle toys, or static generative art.",
    "Graphics are the point: every concept must put GPU-driven visuals front and centre — custom GLSL shaders, lighting, post-processing, particles — used in service of actual gameplay.",
    "Each idea must be (1) a genuinely DISTINCT game — a different genre and core mechanic from the others and from everything on the AVOID list, (2) replayable and fun, not a 30-second tech demo, (3) buildable in a focused session by a strong coding agent.",
  ].join("\n");

  // Grounded game batches RESEARCH the live web-game scene first — fresh techniques,
  // jam winners, what players are asking for — instead of inventing in a vacuum.
  const discovery = [
    "RESEARCH FIRST — you have a live web_search tool. Actually run several searches before you invent anything.",
    "Hunt for what's exciting or newly possible in browser games right now, for example:",
    "  • Fresh graphics techniques — recent Three.js releases and examples, TSL/WebGPU demos, Shadertoy trends, standout WebGL showcases (Awwwards, Codrops) worth building a game around.",
    "  • What indie web games are landing — js13kGames / Ludum Dare / itch.io browser-game winners and their mechanics; what players praise or wish existed in r/WebGames, r/threejs, r/incremental_games.",
    "  • New capabilities — WebGPU adoption, browser APIs (gamepad, WebXR, audio), or model abilities that make a previously-hard game newly buildable.",
    "Turn those real signals into original games — don't clone what you find; build on the technique or fill the gap. Each pitch should reflect the actual signal that inspired it.",
  ];

  const user = [
    `Generate ${count} browser game ideas as a JSON array. Each item:`,
    '{ "title": string (<=4 words), "pitch": string (2-3 sentences: who it\'s for, the core gameplay loop, and what makes it visually striking), "tags": string[] (2-4, include the key graphics tech, e.g. "three.js", "GLSL", "WebGL"), "lens": string (game genre, e.g. "arcade", "puzzle", "roguelite", "rhythm", "tower defense"), "ambition": "S" | "M" | "L" (S=tight one-screen game, M=several systems & screens, L=substantial game with progression) }',
    "Respond with ONLY the JSON array. No prose, no code fences.",
    "",
    ...(grounded ? discovery : []),
    "Make every game lean hard on real-time graphics — shader-driven visuals, 3D scenes, dynamic lighting or post-processing — built on Three.js (optionally react-three-fiber + drei), GLSL, and where useful a physics lib (Rapier / cannon-es) and the Web Audio API. Avoid plain DOM / 2D-canvas games with no GPU graphics.",
    "Spread the batch across different genres and mechanics — keep the games far apart from one another.",
    settings.steer ? `\nHuman steering to honor: ${settings.steer}` : "",
    avoidTitles.length
      ? "\nAVOID — do NOT repeat or closely resemble any of these existing concepts. Pick genuinely different genres and mechanics:\n" + avoidTitles.map((t) => "  – " + t).join("\n")
      : "",
  ].join("\n");
  return { system, user };
}

/* ---------------- spec ---------------- */
export function buildSpecPrompt(p: Project): Prompt {
  if (p.kind === "game") return buildGameSpecPrompt(p);
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

/* ---------------- game spec ----------------
 * Same contract as buildSpecPrompt, but the stack defaults to Three.js/WebGL and a
 * dedicated "Rendering & Visual FX" section makes the shader work the centerpiece. */
export function buildGameSpecPrompt(p: Project): Prompt {
  const scope = ({
    S: "a tight, one-screen game (a single core loop, highly polished)",
    M: "a game with several systems and screens (a real loop plus progression and UI)",
    L: "an ambitious game (multiple mechanics, progression, and a rich world)",
  } as Record<string, string>)[p.ambition] || "a focused but polished browser game";
  const system = [
    "You are the Lead Game Engineer at VIBE FORGE GAMES. Turn a game concept into a precise, build-ready spec the user will hand to their AI coding assistant (Claude Code, Cursor, Codex…).",
    "The spec must let a strong coding agent build the complete game in one focused session with no further questions: name the engine, libraries, architecture, game state, and the full mechanic & rendering set. Be concrete and decisive — make the technical, gameplay, and visual calls yourself.",
    "Default to a modern real-time browser stack: Vite + TypeScript + Three.js (use react-three-fiber + drei when React fits), custom GLSL shaders, post-processing (the `postprocessing` lib / EffectComposer), a physics lib (Rapier or cannon-es) when the game needs it, and the Web Audio API for sound. Target a smooth 60fps game loop.",
  ].join("\n");
  const user = [
    `Game — Title: ${p.title} | Pitch: ${p.pitch} | Genre: ${p.lens || "—"} | Tags: ${(p.tags || []).join(", ")}`,
    `Target scope: ${scope}.`,
    "",
    "Write the spec in Markdown with exactly these sections, ambitious yet implementable in one focused pass:",
    `# ${p.title}`,
    "## Concept & Core Loop  (the fantasy, moment-to-moment gameplay, win/lose, why it's fun)",
    "## Gameplay & Mechanics  (controls, systems, rules, difficulty/balancing, scoring/progression)",
    "## Tech Stack  (engine & renderer: Three.js / react-three-fiber; shaders: GLSL; physics; audio; state; build)",
    "## Rendering & Visual FX  (the centerpiece: custom shaders, materials, lighting, particles, post-processing, the overall look)",
    "## Architecture & File Structure  (scenes, the game loop, systems/entities and their responsibilities)",
    "## Game State & Data  (entities & shapes, run/save persistence, seed/sample content)",
    "## Audio & Game Feel  (sound design, camera, juice/feedback, haptics where relevant)",
    "## Getting Started  (how to scaffold and run: commands, suggested npm scripts)",
    "## Acceptance Criteria  (a checklist proving the game runs smoothly and the core loop, shaders, and controls actually work)",
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
