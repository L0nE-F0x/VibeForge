// The page's worker: it opens the page when a buzz is tapped, and keeps the phone's own copy of the
// page so the app still opens when the computer it was installed from is off. With several
// computers, that is the moment the other one is wanted.

const COPY = "vibeforge-page";
/** How long the computer has to send a file before the phone's own copy is used instead. */
const WAIT_MS = 4000;
/** After the page itself came from the copy, its files do too for this long: one page, one version. */
const WHOLE_MS = 20_000;
let copyUntil = 0;

self.addEventListener("install", () => void self.skipWaiting());

self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  // Only the page's own files. What the computers say (/api/) is never kept, here or in the browser.
  if (url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return;
  event.respondWith(pageFile(request));
});

/**
 * The computer's file when it sends one in time, and that becomes the phone's copy; the copy when
 * it doesn't (off, asleep, VibeForge closed behind Tailscale Serve). The computer always comes
 * first, so an update reaches the phone the next time the page opens.
 */
async function pageFile(request) {
  const copy = await caches.open(COPY);
  const kept = await copy.match(request, { ignoreSearch: true });
  const page = request.mode === "navigate";
  if (kept && !page && Date.now() < copyUntil) return kept;
  const abort = new AbortController();
  const limit = setTimeout(() => abort.abort(), WAIT_MS);
  try {
    const response = await fetch(request, kept ? { signal: abort.signal } : {});
    if (response.ok) {
      if (page) copyUntil = 0;
      void copy.put(request, response.clone());
      return response;
    }
    // Tailscale answers for a computer whose VibeForge is closed.
    if (!kept || ![502, 503, 504].includes(response.status)) return response;
  } catch (error) {
    if (!kept) throw error;
  } finally {
    clearTimeout(limit);
  }
  // Once any file falls back to cache, serve the rest of the load from cache too so mixed versions never run together.
  copyUntil = Date.now() + WHOLE_MS;
  return kept;
}

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  event.waitUntil(
    (async () => {
      const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const open = data.ptyId || data.runId ? { type: "open", ptyId: data.ptyId || "", runId: data.runId || "" } : null;
      if (all[0]) {
        await all[0].focus();
        if (open) all[0].postMessage(open);
        return;
      }
      await self.clients.openWindow("/");
    })(),
  );
});
