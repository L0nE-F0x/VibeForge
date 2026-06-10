# Vibe Forge

An **AI app-idea & spec studio**. Generate grounded, genuinely useful app ideas, turn the one you
like into a build-ready spec, then copy or export it (`.md`) straight into your coding assistant —
Claude Code, Cursor, Codex, anything.

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
Installable as a desktop PWA from the browser's address bar.

## Deploy to Netlify (drag & drop — no CLI)

A ready-to-deploy zip is produced at **`Desktop/VibeForge-netlify.zip`** (regenerate with the steps
below). On [app.netlify.com](https://app.netlify.com): **Add new site → Deploy manually**, then drag
the **zip** onto the drop zone. That's it — the static site goes live and the relay function
(`/api/complete`) deploys with it. No environment variables needed (keys are per-user, in-browser).

To rebuild the deploy zip yourself: `npm run build` (→ `web/dist`), then bundle
`netlify/functions/complete.mts` to a self-contained `.mjs`, and zip `web/dist/*` + `netlify/` +
`_redirects` so those files sit at the **root** of the archive.

## Architecture

- **`web/`** — Vite + React + TypeScript SPA (the studio). State + your keys persist in
  `localStorage`; nothing is sent to a server except inside your own provider requests.
- **`shared/`** — the provider registry/types (`index.ts`) and the pure completion engine
  (`complete.ts`), used by **both** the Vite dev middleware and the Netlify function, so dev and
  prod behave identically.
- **`netlify/functions/complete.mts`** — the cloud-provider relay. It only forwards to a fixed
  allow-list of known provider hosts (no open proxy), passing your key through per-request without
  storing or logging it.

Providers, depth dial (focused tool → ambitious product), creative steering, and live-search
grounding are all configured in Settings.
