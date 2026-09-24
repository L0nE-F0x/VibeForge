/// <reference types="vite/client" />
import type { ForgeApi } from "./shared/api";

declare global {
  interface Window {
    forgedesk: ForgeApi;
  }
}

export {};
