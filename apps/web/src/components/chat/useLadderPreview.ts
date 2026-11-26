import { useEffect, useRef, useState, type FocusEvent } from "react";

/** Keys that move the menu highlight; typeahead is any single printable key. */
const NAVIGATION_KEYS = new Set(["ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown"]);

/** `data-*` attribute selector for a camelCase dataset key (`effortLevel` → `[data-effort-level]`). */
function datasetSelector(datasetKey: string): string {
  return `[data-${datasetKey.replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`)}]`;
}

/**
 * Highlight preview for a "ladder" menu section (reasoning effort, access): while the user moves
 * the highlight over the rows, `previewValue` is the highlighted row's `data-*` value, so the
 * section can show that row's fill. Spread `groupProps` on the element that contains the rows.
 *
 * Opening a menu from the keyboard focuses its first row, so the preview starts only once the
 * user actually moves the highlight (pointer, navigation key or typeahead); until then the ladder
 * keeps showing the stored selection.
 */
export function useLadderPreview(datasetKey: string) {
  const [previewValue, setPreviewValue] = useState<string | null>(null);
  const navigatedRef = useRef(false);
  useEffect(() => {
    const markNavigated = (event: KeyboardEvent) => {
      if (NAVIGATION_KEYS.has(event.key) || event.key.length === 1) {
        navigatedRef.current = true;
      }
    };
    document.addEventListener("keydown", markNavigated, true);
    return () => document.removeEventListener("keydown", markNavigated, true);
  }, []);

  const selector = datasetSelector(datasetKey);
  const groupProps = {
    onPointerMoveCapture: () => {
      navigatedRef.current = true;
    },
    onFocus: (event: FocusEvent<HTMLElement>) => {
      if (!navigatedRef.current || !(event.target instanceof HTMLElement)) return;
      setPreviewValue(event.target.closest<HTMLElement>(selector)?.dataset[datasetKey] ?? null);
    },
    onBlur: (event: FocusEvent<HTMLElement>) => {
      if (
        !(event.relatedTarget instanceof Node) ||
        !event.currentTarget.contains(event.relatedTarget)
      ) {
        setPreviewValue(null);
      }
    },
  };

  return { previewValue, groupProps };
}
