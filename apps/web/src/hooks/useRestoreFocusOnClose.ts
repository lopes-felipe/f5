import { useEffect, useRef, type RefObject } from "react";

export interface UseRestoreFocusOnCloseOptions {
  /** Whether the transient panel, drawer, or dialog is currently open. */
  readonly open: boolean;
  /** Optional container ref; focus is restored only if activeElement is inside it or on body. */
  readonly containerRef?: RefObject<HTMLElement | null> | undefined;
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

function isFocusLostOrInsideContainer(
  active: Element | null,
  container: HTMLElement | null | undefined,
): boolean {
  return (
    active === null ||
    active === document.body ||
    active === document.documentElement ||
    Boolean(container && container.contains(active))
  );
}

/**
 * Captures the focused trigger element when a transient surface opens and
 * restores focus when it closes, re-checking `document.activeElement` inside
 * the animation frame so focus is never stolen if another control was focused
 * in the meantime.
 */
export function useRestoreFocusOnClose(options: UseRestoreFocusOnCloseOptions): void {
  const { open, containerRef } = options;
  const previousOpenRef = useRef(open);
  const triggerElementRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const wasOpen = previousOpenRef.current;
    previousOpenRef.current = open;

    if (!wasOpen && open) {
      triggerElementRef.current = resolveFocusableElement(document.activeElement);
      return;
    }

    if (wasOpen && !open) {
      const trigger = triggerElementRef.current;
      triggerElementRef.current = null;

      if (!isFocusLostOrInsideContainer(document.activeElement, containerRef?.current)) {
        return;
      }

      if (!trigger || !trigger.isConnected) {
        return;
      }

      const rafId = window.requestAnimationFrame(() => {
        if (
          trigger.isConnected &&
          isFocusLostOrInsideContainer(document.activeElement, containerRef?.current)
        ) {
          trigger.focus({ preventScroll: true });
        }
      });

      return () => {
        window.cancelAnimationFrame(rafId);
      };
    }

    return undefined;
  }, [containerRef, open]);
}
