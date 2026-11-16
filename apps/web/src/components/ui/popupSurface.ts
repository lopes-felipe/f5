/** Shared surface for anchored popups and hover previews. */
export const popupSurfaceClassName =
  "relative flex h-(--popup-height,auto) w-(--popup-width,auto) origin-(--transform-origin) rounded-lg border bg-popover text-popover-foreground shadow-lg/5 outline-none transition-[width,height,scale,opacity] has-data-[slot=calendar]:rounded-xl data-ending-style:scale-98 data-starting-style:scale-98 data-ending-style:opacity-0 data-starting-style:opacity-0";
