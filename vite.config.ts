import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";
import electron from "vite-plugin-electron/simple";

/** A strict Content-Security-Policy for the packaged page. Dev keeps Vite's inline HMR scripts working. */
function contentSecurityPolicy(): Plugin {
  const policy = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self' data:",
    "img-src 'self' data:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
  ].join("; ");
  return {
    name: "vibeforge-csp",
    apply: "build",
    transformIndexHtml: () => [{ tag: "meta", attrs: { "http-equiv": "Content-Security-Policy", content: policy }, injectTo: "head-prepend" }],
  };
}

export default defineConfig({
  base: "./",
  plugins: [
    react(),
    contentSecurityPolicy(),
    electron({
      // Every `node:` import stays external. The plugin only knows the built-ins of the Node doing
      // the build, and Node 22 doesn't list node:sqlite, so building there would bundle a stub.
      main: { entry: "electron/main.ts", vite: { build: { rollupOptions: { external: [/^node:/] } } } },
      preload: { input: "electron/preload.ts" },
    }),
  ],
  build: {
    chunkSizeWarningLimit: 2500,
  },
});
