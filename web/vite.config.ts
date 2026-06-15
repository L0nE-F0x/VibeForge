import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { handleProxyComplete } from "../shared/src/complete.ts";

/** Serves the SAME relay handler the Netlify Function uses, at the same path —
 *  full dev/prod parity for the cloud-provider proxy without netlify-cli. */
function devApi(): Plugin {
  return {
    name: "vibeforge-dev-api",
    configureServer(server) {
      server.middlewares.use("/api/complete", (req, res) => {
        if ((req.method || "") !== "POST") {
          res.statusCode = 405;
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ error: "Method not allowed" }));
          return;
        }
        let body = "";
        req.on("data", (c) => { body += c; });
        req.on("end", async () => {
          let raw: unknown = null;
          try { raw = JSON.parse(body || "null"); } catch { /* handled below */ }
          const out = await handleProxyComplete(raw);
          res.statusCode = out.status;
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify(out.body));
        });
      });
    },
  };
}

/** Bakes the live site origin into index.html's social/canonical tags.
 *  On Netlify, $URL is the site's primary address (custom domain included);
 *  otherwise we fall back to the production domain. OG/Twitter crawlers
 *  require absolute URLs, so this keeps them correct on any deploy. */
function ogMeta(): Plugin {
  const FALLBACK = "https://vibeforgeapp.netlify.app";
  const origin = (process.env.URL || process.env.DEPLOY_PRIME_URL || FALLBACK).replace(/\/+$/, "");
  return {
    name: "vibeforge-og-meta",
    transformIndexHtml(html) {
      return html.replaceAll("__SITE_ORIGIN__", origin);
    },
  };
}

export default defineConfig({
  plugins: [react(), devApi(), ogMeta()],
  resolve: {
    dedupe: ["react", "react-dom"],
    alias: [
      { find: "@vibeforge/shared/complete", replacement: fileURLToPath(new URL("../shared/src/complete.ts", import.meta.url)) },
      { find: "@vibeforge/shared", replacement: fileURLToPath(new URL("../shared/src/index.ts", import.meta.url)) },
    ],
  },
  server: {
    port: 5173,
    strictPort: true,
    fs: { strict: false },
  },
});
