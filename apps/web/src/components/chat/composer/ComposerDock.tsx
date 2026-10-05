import { useLayoutEffect, useRef, type ReactNode } from "react";

import { cn } from "~/lib/utils";

export const COMPOSER_DOCK_HEIGHT_VAR = "--composer-dock-height";

const DOCK_HOST_SELECTOR = "[data-composer-dock-host]";
const DOCK_SELECTOR = '[data-slot="composer-dock"]';

function publishDockHeight(host: HTMLElement, dock: HTMLElement): void {
  host.style.setProperty(COMPOSER_DOCK_HEIGHT_VAR, `${Math.ceil(dock.offsetHeight)}px`);
}

/**
 * Floats the composer (with its tray and branch line) over the bottom of the
 * timeline, behind a short fade. Its measured height is published on the
 * closest `data-composer-dock-host` ancestor as `--composer-dock-height` so the
 * timeline can reserve the same space at its end: the last message is never
 * hidden and "at end" detection measures against the padded content.
 */
export function ComposerDock(props: { children: ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const element = ref.current;
    const host = element?.closest<HTMLElement>(DOCK_HOST_SELECTOR) ?? element?.parentElement;
    if (!element || !host) return;
    const publish = () => publishDockHeight(host, element);
    publish();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(publish);
    observer.observe(element);
    return () => {
      observer.disconnect();
      host.style.removeProperty(COMPOSER_DOCK_HEIGHT_VAR);
    };
  }, []);

  return (
    <div
      ref={ref}
      data-slot="composer-dock"
      className={cn(
        "pointer-events-none absolute inset-x-0 bottom-0 z-20 pb-safe-add",
        // The fade starts above the dock so scrolled text dissolves before it
        // reaches the composer instead of being cut off at its edge.
        "before:pointer-events-none before:absolute before:inset-x-0 before:-top-6 before:bottom-0 before:bg-linear-to-t before:from-background before:from-60% before:to-transparent",
        props.className,
      )}
    >
      <div className="pointer-events-auto relative">{props.children}</div>
    </div>
  );
}

/**
 * Space at the end of a scrolling list that matches the dock's height.
 *
 * The dock renders after the list, so its own layout effect runs after the
 * list has measured this spacer. Publishing the height from here first means
 * the list's first measurement (and its initial scroll to the end) already
 * includes the full reserve instead of correcting it a frame later, which
 * would pull a reader who had just scrolled up back toward the end.
 */
export function ComposerDockSpacer(props: { className?: string }) {
  const ref = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const host = ref.current?.closest<HTMLElement>(DOCK_HOST_SELECTOR);
    const dock = host?.querySelector<HTMLElement>(DOCK_SELECTOR);
    if (host && dock) publishDockHeight(host, dock);
  }, []);

  return <div ref={ref} data-slot="timeline-dock-spacer" className={props.className} />;
}
