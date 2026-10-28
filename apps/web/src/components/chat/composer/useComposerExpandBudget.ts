import { useLayoutEffect, useState, type RefObject } from "react";

const DOCK_HOST_SELECTOR = "[data-composer-dock-host]";
const DOCK_SELECTOR = '[data-slot="composer-dock"]';
const EDITOR_SELECTOR = '[data-testid="composer-editor"]';

/** The expanded editor never grows past this, however tall the window. */
export const COMPOSER_EXPAND_MAX_HEIGHT_PX = 576;
/** Below this there is no room worth expanding into, so the toggle hides. */
export const COMPOSER_EXPAND_MIN_HEIGHT_PX = 280;

/**
 * The expanded editor's max height, on an 8px grid. The whole dock stack
 * (tray, composer chrome, branch line) must fit in half the dock host and
 * within the dock's own max height (the redesign caps it at 55% of the chat
 * column), so only the editor grows and the dock never scrolls. Null when that
 * leaves less than the minimum.
 */
export function computeComposerExpandBudget(input: {
  hostHeight: number;
  /** Height of everything the dock stacks, the editor included. */
  stackHeight: number;
  editorHeight: number;
  /** The dock's CSS max height, when it has one. */
  dockMaxHeight?: number;
}): number | null {
  const room = Math.min(input.hostHeight * 0.5, input.dockMaxHeight ?? Number.POSITIVE_INFINITY);
  const available = Math.min(
    COMPOSER_EXPAND_MAX_HEIGHT_PX,
    room - (input.stackHeight - input.editorHeight),
  );
  const budget = Math.floor(available / 8) * 8;
  return budget >= COMPOSER_EXPAND_MIN_HEIGHT_PX ? budget : null;
}

/** The dock's laid-out content height: its children, which may overflow a capped dock. */
function dockStackHeight(dock: HTMLElement): number {
  const stack = dock.firstElementChild;
  return stack instanceof HTMLElement ? stack.offsetHeight : dock.scrollHeight;
}

/**
 * Tracks the expanded editor's height budget. Bounded by the dock host and the
 * dock's own cap in either dock layout, and re-measured when the tray, the
 * composer or the host resizes.
 */
export function useComposerExpandBudget(formRef: RefObject<HTMLFormElement | null>): number | null {
  const [budget, setBudget] = useState<number | null>(null);

  useLayoutEffect(() => {
    const form = formRef.current;
    if (!form) return;
    const host = form.closest<HTMLElement>(DOCK_HOST_SELECTOR);
    const dock = form.closest<HTMLElement>(DOCK_SELECTOR);
    const measure = () => {
      const editor = form.querySelector<HTMLElement>(EDITOR_SELECTOR);
      if (!host || !editor) {
        setBudget(null);
        return;
      }
      // Only a resolved length caps the dock (`100%` means the host, already bounded).
      const cssMaxHeight = dock ? getComputedStyle(dock).maxHeight : "";
      const maxHeight = cssMaxHeight.endsWith("px") ? Number.parseFloat(cssMaxHeight) : Number.NaN;
      setBudget(
        computeComposerExpandBudget({
          hostHeight: host.clientHeight,
          stackHeight: dock ? dockStackHeight(dock) : form.offsetHeight,
          editorHeight: editor.offsetHeight,
          ...(Number.isFinite(maxHeight) ? { dockMaxHeight: maxHeight } : {}),
        }),
      );
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(form);
    if (host) observer.observe(host);
    // The tray and branch line share the dock with the composer.
    const stack = dock?.firstElementChild;
    if (stack) observer.observe(stack);
    return () => observer.disconnect();
  }, [formRef]);

  return budget;
}
