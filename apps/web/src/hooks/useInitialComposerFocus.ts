import { useEffect } from "react";
import { shouldOfferComposerFocus } from "../lib/keyboardFocus";

/** Offer initial focus after the thread's composer mounts. */
export function useInitialComposerFocus(
  threadId: string | undefined,
  terminalOpen: boolean,
  focusComposer: () => void,
): void {
  useEffect(() => {
    if (!threadId || terminalOpen) return;
    const frame = window.requestAnimationFrame(() => {
      // Hydration may finish after the user has started editing or opened a
      // popup. Check at execution time; never move an existing caret to the end.
      if (!shouldOfferComposerFocus()) return;
      focusComposer();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [threadId, focusComposer, terminalOpen]);
}
