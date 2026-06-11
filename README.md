# Vibe Forge

An **AI app-idea & spec studio**. Generate grounded, genuinely useful app ideas, turn the one you
like into a build-ready spec, then hand it to your coding assistant — copy the spec, copy a
ready-to-run **kickoff prompt**, or download it as `.md`. Works with Claude Code, Cursor, Codex,
anything.

**Bring your own key.** Pick your preferred model and paste your API key; it's stored only in your
browser. Cloud providers (Anthropic incl. **Fable 5**, OpenAI, Google, xAI, OpenRouter) relay
through a tiny serverless function so CORS is never an issue; **local models** (Ollama, LM Studio)
and any OpenAI-compatible endpoint are called directly from the browser.

```
 Generate ideas  →  pick one  →  draft the spec  →  refine  →  copy / export .md
   (your model)                    (your model)                  → your coding assistant
```

## Run it locally

```bash
npm install        # first time only
npm run dev        # → http://localhost:5173
```

Open Settings, choose your provider + paste a key, then **Generate ideas**.
On Windows you can instead double-click **`Start Vibe Forge.cmd`** to launch the dev server.
Installable as a desktop PWA from the browser's address bar.

## Deploy to Netlify

The repo ships a `netlify.toml`, so the simplest path is to **connect the Git repo** on
[app.netlify.com](https://app.netlify.com) (**Add new site → Import an existing project**). Netlify
reads the config, runs `npm run build`, publishes `web/dist`, bundles the relay function, and wires
up `/api/complete` plus the SPA fallback. **No environment variables needed** — keys are per-user,
in the browser.

**Prefer no CLI and no Git?** Build locally with `npm run build` (→ `web/dist`), bundle
`netlify/functions/complete.mts` to a self-contained `.mjs`, then zip `web/dist/*` + `netlify/` +
`netlify.toml` so those files sit at the **root** of the archive. On Netlify choose **Add new site
→ Deploy manually** and drag the zip onto the drop zone — the static site goes live and the relay
function deploys with it.

## Architecture

- **`web/`** — Vite + React + TypeScript SPA (the studio). State + your keys persist in
  `localStorage`; nothing is sent to a server except inside your own provider requests.
- **`shared/`** — the provider registry/types (`index.ts`) and the pure completion engine
  (`complete.ts`), used by **both** the Vite dev middleware and the Netlify function, so dev and
  prod behave identically.
- **`netlify/functions/complete.mts`** — the cloud-provider relay. It only forwards to a fixed
  allow-list of known provider hosts (no open proxy), passing your key through per-request without
  storing or logging it.
- **`netlify.toml`** — build + routing config (build command, publish dir, function bundler, and
  the `/api/complete` + SPA-fallback redirects), so a git-connected Netlify deploy works with no
  extra setup.

Providers, batch size, depth dial (focused tool → ambitious product, plus a **Games** mode that
generates graphics-rich browser games built on Three.js/WebGL with custom GLSL shaders), creative
steering, and live-search grounding are all configured in Settings.
