import "@fontsource-variable/geist";
import "@fontsource-variable/jetbrains-mono";
import "@xterm/xterm/css/xterm.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { markWindowFocus } from "./api.js";
import "./styles/app.css";
import { initTheme } from "./theme.js";

markWindowFocus();
void initTheme().finally(() => {
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
});
