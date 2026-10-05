import { useLayoutEffect, useRef, type ReactNode } from "react";

import { cn } from "~/lib/utils";

export const COMPOSER_DOCK_HEIGHT_VAR = "--composer-dock-height";

const DOCK_HOST_SELECTOR = "[data-composer-dock-host]";
const DOCK_SELECTOR = '[data-slot="composer-dock"]';

const TIMELINE_SCROLLER_SELECTOR = '[data-slot="messages-scroll-container"]';
/** How close to the end (in px) still counts as "reading the latest". */
const END_PIN_THRESHOLD_PX = 2;

function publishDockHeight(host: HTMLElement, dock: HTMLElement): void {
  host.style.setProperty(COMPOSER_DOCK_HEIGHT_VAR, `${Math.ceil(dock.offsetHeight)}px`);
}

/**
 * Publishes a resized dock and keeps the timeline pinned to its end when it
 * was there. The timeline's end spacer grows with the dock, which the list
 * does not treat as new content, so a reader at the end would otherwise see
 * the last message slide under a growing composer.
 */
function publishDockResize(host: HTMLElement, dock: HTMLElement): void {
  const previous = host.style.getPropertyValue(COMPOSER_DOCK_HEIGHT_VAR);
  const scroller = host.querySelector<HTMLElement>(TIMELINE_SCROLLER_SELECTOR);
  const wasAtEnd =
    scroller !== null &&
    scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <= END_PIN_THRESHOLD_PX;
  publishDockHeight(host, dock);
  if (!scroller || !wasAtEnd) return;
  if (host.style.getPropertyValue(COMPOSER_DOCK_HEIGHT_VAR) === previous) return;
  const pin = () => {
    scroller.scrollTop = scroller.scrollHeight;
  };
  pin();
  // The list may re-measure its footer on the next frame; pin once more.
  requestAnimationFrame(pin);
}

/**
 * Floats the composer (with its tray and branch line) over the bottom of the
 * timeline, behind a short fade. Its measured height is published on the
 * closest `data-composer-dock-host` ancestor as `--composer-dock-height` so the
 * timeline can reserve the same space at its end: the last message is never
 * hidden and "at end" detection measures against the padded content.
 *
 * The dock never grows taller than its host: its column is a flex stack in
 * which only the tray shrinks (and scrolls), so the composer stays reachable
 * with a short window, an open terminal or several pending questions. Only
 * the centred column takes pointer events; wheel and clicks over the side
 * gutters reach the timeline underneath.
 *
 * `redesign` (the server's opt-in `composer-redesign` capability) switches to
 * that design's bounded input bar instead: nothing shrinks, the dock is
 * capped at 55% of the chat column (`[data-composer-input-bar]` in
 * index.css) and the whole stack scrolls.
 */
export function ComposerDock(props: {
  children: ReactNode;
  className?: string;
  redesign?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const element = ref.current;
    const host = element?.closest<HTMLElement>(DOCK_HOST_SELECTOR) ?? element?.parentElement;
    if (!element || !host) return;
    publishDockHeight(host, element);
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => publishDockResize(host, element));
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
      data-composer-input-bar={props.redesign || undefined}
      className={cn(
        "pointer-events-none absolute inset-x-0 bottom-0 z-20 flex max-h-full flex-col pb-safe-add",
        // The fade starts above the dock so scrolled text dissolves before it
        // reaches the composer instead of being cut off at its edge.
        "before:pointer-events-none before:absolute before:inset-x-0 before:-top-6 before:bottom-0 before:bg-linear-to-t before:from-background before:from-60% before:to-transparent",
        props.className,
      )}
    >
      <div className={cn("relative flex flex-col", !props.redesign && "min-h-0")}>
        {props.children}
      </div>
    </div>
  );
}

/**
 * The dock's centred column (tray, composer, branch line). It is the only
 * part of the dock that receives pointer events.
 */
export function ComposerDockColumn(props: {
  children: ReactNode;
  className?: string;
  redesign?: boolean;
}) {
  return (
    <div
      data-slot="composer-dock-column"
      data-composer-redesign={props.redesign || undefined}
      className={cn(
        "pointer-events-auto mx-auto flex w-full max-w-[calc(var(--chat-content-max-width)+2.5rem)] flex-col px-3 sm:px-5",
        !props.redesign && "min-h-0",
        props.className,
      )}
    >
      {props.children}
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
