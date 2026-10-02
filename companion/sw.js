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

self.addEventListener("message", (event) => {
  const data = event.data;
  if (!data || data.type !== "notify") return;
  event.waitUntil(self.registration.showNotification(data.title || "VibeForge", { body: data.body || "", tag: data.tag, renotify: true, data: data.data || {} }));
});
