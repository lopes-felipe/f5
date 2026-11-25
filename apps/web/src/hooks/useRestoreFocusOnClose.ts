import { useEffect, useRef, type RefObject } from "react";

export interface UseRestoreFocusOnCloseOptions {
  /** Whether the transient panel, drawer, or dialog is currently open. */
  readonly open: boolean;
  /** Optional container ref; focus is restored if activeElement is still inside it or on body. */
  readonly containerRef?: RefObject<HTMLElement | null> | undefined;
  /** Optional fallback element to focus if the original trigger is no longer connected. */
  readonly fallbackRef?: RefObject<HTMLElement | null> | undefined;
  /** Disable focus restoration dynamically when needed. */
  readonly enabled?: boolean | undefined;
}

function resolveFocusableElement(element: Element | null): HTMLElement | null {
  if (!(element instanceof HTMLElement)) {
    return null;
  }
  if (element === document.body || element === document.documentElement) {
    return null;
  }
  return element;
}

/**
 * Captures the focused trigger element when a transient surface opens and
 * restores focus when it closes, guarding against detached nodes and avoiding
 * stealing focus if the user has already focused another surface.
 */
export function useRestoreFocusOnClose(options: UseRestoreFocusOnCloseOptions): void {
  const { open, containerRef, fallbackRef, enabled = true } = options;
  const previousOpenRef = useRef(open);
  const triggerElementRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!enabled) {
      previousOpenRef.current = open;
      return;
    }

    const wasOpen = previousOpenRef.current;
    previousOpenRef.current = open;

    if (!wasOpen && open) {
      triggerElementRef.current = resolveFocusableElement(document.activeElement);
      return;
    }

    if (wasOpen && !open) {
      const trigger = triggerElementRef.current;
      triggerElementRef.current = null;

      const active = document.activeElement;
      const focusWasLostOrInsideContainer =
        active === null ||
        active === document.body ||
        active === document.documentElement ||
        Boolean(containerRef?.current && containerRef.current.contains(active));

      if (!focusWasLostOrInsideContainer) {
        return;
      }

      const target =
        trigger && trigger.isConnected
          ? trigger
          : fallbackRef?.current && fallbackRef.current.isConnected
            ? fallbackRef.current
            : null;

      if (!target) {
        return;
      }

      const rafId = window.requestAnimationFrame(() => {
        if (target.isConnected) {
          target.focus({ preventScroll: true });
        }
      });

      return () => {
        window.cancelAnimationFrame(rafId);
      };
    }

    return undefined;
  }, [containerRef, enabled, fallbackRef, open]);
}
