import { memo, useCallback, useState, type MouseEvent } from "react";
import { cn } from "../../lib/utils";
import {
  resolveTimelineTurnRailHeightStyle,
  resolveTimelineTurnRailIndexFromPointer,
  resolveTimelineTurnRailInteractiveWidth,
  resolveTimelineTurnRailTopPercent,
  type TimelineTurnRailItem,
} from "./MessagesTimeline.logic";

function timelineTurnRailEventTargetsPreview(target: EventTarget): boolean {
  return target instanceof Element && target.closest("[data-turn-rail-preview]") !== null;
}

// Memoized: a long thread has one tick per turn, and the timeline re-renders on
// every scroll and stream update while these props rarely change.
export const TimelineTurnRail = memo(function TimelineTurnRail(props: {
  items: ReadonlyArray<TimelineTurnRailItem>;
  hasPersistentGutter: boolean;
  hitStripWidth: number;
  activeTickIndex: number;
  onSelect: (item: TimelineTurnRailItem) => void;
  side?: "left" | "right";
  target?: "user" | "assistant";
  /** Native, non-passive wheel listener so the rail can scroll the timeline under it. */
  onWheel?: (event: WheelEvent) => void;
}) {
  const { onWheel } = props;
  const right = props.side === "right";
  const assistant = props.target === "assistant";
  const testId = assistant ? "timeline-assistant-rail" : "timeline-turn-rail";
  const wheelTargetRef = useCallback(
    (node: HTMLDivElement | null) => {
      if (!node || !onWheel) return;
      node.addEventListener("wheel", onWheel, { passive: false });
      return () => node.removeEventListener("wheel", onWheel);
    },
    [onWheel],
  );
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const resolvedActiveIndex =
    activeIndex !== null && activeIndex < props.items.length ? activeIndex : null;
  const activeItem =
    resolvedActiveIndex === null ? null : (props.items[resolvedActiveIndex] ?? null);
  const primaryText = assistant ? activeItem?.assistantText : activeItem?.userText;
  const secondaryText = assistant ? activeItem?.userText : activeItem?.assistantText;
  const fallbackLabel = assistant ? "Agent response" : "User message";
  const activeTopPercent =
    resolvedActiveIndex === null
      ? 0
      : resolveTimelineTurnRailTopPercent(resolvedActiveIndex, props.items.length);
  const activeTooltipTranslate =
    resolvedActiveIndex === null
      ? "-50%"
      : resolvedActiveIndex === 0
        ? "0%"
        : resolvedActiveIndex === props.items.length - 1
          ? "-100%"
          : "-50%";

  const resolveActiveIndexFromPointer = useCallback(
    (event: MouseEvent<HTMLElement>) => {
      const rect = event.currentTarget.getBoundingClientRect();
      return resolveTimelineTurnRailIndexFromPointer({
        itemCount: props.items.length,
        railTop: rect.top,
        railHeight: rect.height,
        pointerY: event.clientY,
      });
    },
    [props.items.length],
  );
  const moveActiveIndex = useCallback(
    (delta: number) => {
      setActiveIndex((current) =>
        Math.max(0, Math.min(props.items.length - 1, (current ?? 0) + delta)),
      );
    },
    [props.items.length],
  );

  return (
    <div
      ref={wheelTargetRef}
      className={cn(
        "group/turn-rail pointer-events-none absolute inset-y-0 z-20 hidden w-18 [@media(pointer:fine)]:block",
        right ? "right-5" : "left-0",
        props.hasPersistentGutter
          ? "opacity-100"
          : "opacity-60 transition-opacity duration-150 hover:opacity-100 focus-within:opacity-100",
      )}
      data-testid={testId}
      data-rail-side={right ? "right" : "left"}
      data-persistent-gutter={props.hasPersistentGutter ? "true" : "false"}
    >
      <div className="relative h-full w-full select-none">
        <button
          aria-label={`Jump to message: ${primaryText ?? fallbackLabel}`}
          className={cn(
            "absolute top-1/2 -translate-y-1/2 cursor-pointer bg-transparent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70",
            right ? "right-1" : "left-1",
            props.hitStripWidth > 0 ? "pointer-events-auto" : "pointer-events-none",
          )}
          data-testid={`${testId}-strip`}
          onBlur={() => setActiveIndex(null)}
          onClick={(event) => {
            if (timelineTurnRailEventTargetsPreview(event.target)) return;
            const index = resolveActiveIndexFromPointer(event);
            const item = index === null ? null : (props.items[index] ?? null);
            if (item) props.onSelect(item);
            event.currentTarget.blur();
          }}
          onFocus={() => setActiveIndex((current) => current ?? 0)}
          onKeyDown={(event) => {
            // Keyboard movement previews first; Enter/Space commits the jump.
            if (event.key === "ArrowDown" || event.key === "PageDown") {
              event.preventDefault();
              moveActiveIndex(1);
            } else if (event.key === "ArrowUp" || event.key === "PageUp") {
              event.preventDefault();
              moveActiveIndex(-1);
            } else if (event.key === "Home") {
              event.preventDefault();
              setActiveIndex(0);
            } else if (event.key === "End") {
              event.preventDefault();
              setActiveIndex(props.items.length - 1);
            } else if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              if (activeItem) props.onSelect(activeItem);
            }
          }}
          onMouseLeave={() => setActiveIndex(null)}
          onMouseMove={(event) => {
            setActiveIndex(resolveActiveIndexFromPointer(event));
          }}
          onMouseDown={(event) => {
            if (!timelineTurnRailEventTargetsPreview(event.target)) event.preventDefault();
          }}
          style={{
            height: resolveTimelineTurnRailHeightStyle(props.items.length),
            width: resolveTimelineTurnRailInteractiveWidth(
              props.hitStripWidth,
              activeItem !== null,
            ),
          }}
          type="button"
        >
          <div
            className={cn(
              "absolute top-0 h-full w-px bg-border/15",
              right
                ? props.hasPersistentGutter
                  ? "right-3"
                  : "right-0"
                : props.hasPersistentGutter
                  ? "left-3"
                  : "left-0",
            )}
          />
          {props.items.map((item, index) => {
            const activeDistance =
              resolvedActiveIndex === null ? null : Math.abs(index - resolvedActiveIndex);
            return (
              <span
                aria-hidden="true"
                className={cn(
                  "pointer-events-none absolute h-0.5 -translate-y-1/2 rounded-full bg-muted-foreground/35 transition-[background-color,width] duration-150",
                  right ? "right-0" : "left-0",
                  activeDistance === 0
                    ? "w-6 bg-muted-foreground/75"
                    : activeDistance === 1
                      ? "w-4"
                      : activeDistance === 2
                        ? "w-2.5"
                        : "w-2",
                  index === props.activeTickIndex && "bg-foreground/90",
                )}
                data-turn-rail-active={
                  !assistant ? (index === props.activeTickIndex ? "true" : "false") : undefined
                }
                data-turn-rail-tick={!assistant ? "" : undefined}
                data-assistant-rail-active={
                  assistant ? (index === props.activeTickIndex ? "true" : "false") : undefined
                }
                data-assistant-rail-tick={assistant ? "" : undefined}
                key={item.id}
                style={{ top: `${resolveTimelineTurnRailTopPercent(index, props.items.length)}%` }}
              />
            );
          })}
          {activeItem ? (
            <span
              className={cn(
                "pointer-events-auto absolute w-80 max-w-[calc(100vw-4rem)] cursor-text select-text",
                right ? "right-8" : "left-8",
              )}
              data-turn-rail-preview
              onMouseMove={(event) => event.stopPropagation()}
              style={{
                top: `${activeTopPercent}%`,
                transform: `translateY(${activeTooltipTranslate})`,
              }}
            >
              <span className="block rounded-xl border bg-popover p-3 text-left text-popover-foreground shadow-lg/5">
                <span className="block max-w-full overflow-hidden text-ellipsis whitespace-nowrap text-sm font-medium leading-5">
                  {primaryText ?? fallbackLabel}
                </span>
                {secondaryText ? (
                  <span
                    className="mt-1 max-h-[3.75rem] overflow-hidden text-sm leading-5 text-muted-foreground"
                    style={{
                      display: "-webkit-box",
                      WebkitBoxOrient: "vertical",
                      WebkitLineClamp: 3,
                    }}
                  >
                    {secondaryText}
                  </span>
                ) : null}
              </span>
            </span>
          ) : null}
        </button>
      </div>
    </div>
  );
});
