import { Bot, CalendarClock, History, House, KanbanSquare, MessagesSquare, Sparkles, SquareTerminal, type LucideIcon } from "lucide-react";
import type { Settings } from "../shared/api.js";
import type { Key } from "./i18n/index.js";
import type { ViewName } from "./state.js";

export type RailView = Exclude<ViewName, "settings">;

export const VIEWS: Array<{ view: RailView; label: Key; tip: Key; icon: LucideIcon }> = [
  { view: "home", label: "rail.home", tip: "rail.tip.home", icon: House },
  { view: "agents", label: "rail.agents", tip: "rail.tip.agents", icon: Bot },
  { view: "code", label: "rail.code", tip: "rail.tip.code", icon: SquareTerminal },
  { view: "chat", label: "rail.chat", tip: "rail.tip.chat", icon: MessagesSquare },
  { view: "tasks", label: "rail.tasks", tip: "rail.tip.tasks", icon: KanbanSquare },
  { view: "routines", label: "rail.routines", tip: "rail.tip.routines", icon: CalendarClock },
  { view: "skills", label: "rail.skills", tip: "rail.tip.skills", icon: Sparkles },
  { view: "runs", label: "rail.runs", tip: "rail.tip.runs", icon: History },
];

/** Code is where the terminals live, so it always stays in the rail. */
export const PINNED: RailView = "code";

/** Every view in the order the user chose (new views keep their default place), and the ones shown. */
export function railViews(rail: Settings["rail"] | undefined) {
  const order = rail?.order ?? [];
  const hidden = new Set(rail?.hidden ?? []);
  const rank = (view: RailView) => {
    const at = order.indexOf(view);
    return at >= 0 ? at : order.length + VIEWS.findIndex((item) => item.view === view);
  };
  const all = [...VIEWS].sort((a, b) => rank(a.view) - rank(b.view));
  return { all, visible: all.filter((item) => item.view === PINNED || !hidden.has(item.view)), hidden };
}

/** The Ctrl+number that opens a view, or null when it is hidden. */
export function railKey(rail: Settings["rail"] | undefined, view: RailView): string | null {
  const at = railViews(rail).visible.findIndex((item) => item.view === view);
  return at >= 0 && at < 9 ? `Ctrl+${at + 1}` : null;
}
