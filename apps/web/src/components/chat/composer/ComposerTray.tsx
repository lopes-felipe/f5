import type { ReactNode } from "react";

import { cn } from "~/lib/utils";

/** Where a composer-adjacent panel renders: on its own, or as a tray row. */
export type ComposerPanelVariant = "standalone" | "tray";

/** Tray rows drop their own frame; the tray supplies border and dividers. */
export const COMPOSER_TRAY_PANEL_CLASS_NAME = "w-full px-3 py-2.5";

/**
 * Panels that belong to the next send (notices, worktree setup, the turn
 * queue, agent questions, rewind drafts) stacked on the composer's top edge.
 * Collapses to nothing when every row renders null. The notice stack and
 * queue cap their own height; the tray itself is the one part of the dock
 * that shrinks and scrolls when the dock runs out of room.
 *
 * With `redesign` (the opt-in composer redesign) the tray is that design's
 * state-drawer stack: it keeps its natural height up to its own cap
 * (`[data-composer-state-drawers]` in index.css) and the dock scrolls.
 */
export function ComposerTray(props: {
  children: ReactNode;
  className?: string;
  redesign?: boolean;
}) {
  return (
    <div
      data-slot="composer-tray"
      data-composer-state-drawers={props.redesign || undefined}
      className={cn(
        "mx-3 overflow-y-auto overscroll-contain rounded-t-xl border border-b-0 border-border bg-card text-card-foreground empty:hidden",
        props.redesign ? "shrink-0" : "min-h-0",
        "divide-y divide-border",
        props.className,
      )}
    >
      {props.children}
    </div>
  );
}
