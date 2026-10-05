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
 */
export function ComposerTray(props: { children: ReactNode; className?: string }) {
  return (
    <div
      data-slot="composer-tray"
      className={cn(
        "mx-3 min-h-0 overflow-y-auto overscroll-contain rounded-t-xl border border-b-0 border-border bg-card text-card-foreground empty:hidden",
        "divide-y divide-border",
        props.className,
      )}
    >
      {props.children}
    </div>
  );
}
