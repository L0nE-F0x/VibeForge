import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import "./theme.css";

// No StrictMode: keeps the single SSE connection from double-mounting in dev.
createRoot(document.getElementById("root")!).render(<App />);

// PWA: register the service worker so Vibe Forge can be installed as a desktop app.
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  });
}
