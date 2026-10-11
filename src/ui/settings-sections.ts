import { Activity, Bell, Download, FolderOpen, HardDrive, LifeBuoy, Mic, PanelLeft, Palette, Power, Smartphone, SquareTerminal, Volume2, type LucideIcon } from "lucide-react";
import type { Key } from "./i18n/index.js";

/**
 * The sections of Settings, in page order. The page's own list, Ctrl+K and links from elsewhere
 * all use these, so a section is reachable by name from anywhere. Each heading has the id
 * `settings-<id>`.
 */
export const SETTINGS_SECTIONS = [
  { id: "appearance", icon: Palette, label: "settings.appearance" },
  { id: "rail", icon: PanelLeft, label: "settings.rail" },
  { id: "defaults", icon: SquareTerminal, label: "settings.defaults" },
  { id: "voice", icon: Mic, label: "voice.title" },
  { id: "notifications", icon: Bell, label: "settings.notifications" },
  { id: "phone", icon: Smartphone, label: "companion.title" },
  { id: "tray", icon: Power, label: "tray.title" },
  { id: "sounds", icon: Volume2, label: "sounds.title" },
  { id: "usage", icon: Activity, label: "settings.insights" },
  { id: "engines", icon: SquareTerminal, label: "settings.engines" },
  { id: "files", icon: FolderOpen, label: "settings.files" },
  { id: "storage", icon: HardDrive, label: "storage.title" },
  { id: "updates", icon: Download, label: "updates.title" },
  { id: "help", icon: LifeBuoy, label: "settings.help" },
] as const satisfies ReadonlyArray<{ id: string; icon: LucideIcon; label: Key }>;

export type SettingsSection = (typeof SETTINGS_SECTIONS)[number]["id"];

export const sectionAnchor = (id: string) => `settings-${id}`;
