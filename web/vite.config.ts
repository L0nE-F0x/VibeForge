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

export default defineConfig({
  plugins: [react(), devApi()],
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
