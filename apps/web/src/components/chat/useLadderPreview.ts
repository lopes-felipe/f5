import { useEffect, useRef, useState, type FocusEvent, type PointerEvent } from "react";

/** Keys that move the menu highlight; typeahead is any single printable key. */
const NAVIGATION_KEYS = new Set(["ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown"]);

/** `data-*` attribute name for a camelCase dataset key (`effortLevel` → `data-effort-level`). */
function datasetAttribute(datasetKey: string): string {
  return `data-${datasetKey.replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`)}`;
}

/**
 * Highlight preview for a "ladder" menu section (reasoning effort, access): while the user moves
 * the highlight over the rows, `previewValue` is the highlighted row's `data-*` value, so the
 * section can show that row's fill. Spread `groupProps` on the element that contains the rows.
 *
 * Opening a menu from the keyboard focuses its first (or last) row, so the preview starts only once
 * the user actually moves the highlight (pointer, navigation key or typeahead); until then the
 * ladder keeps showing the stored selection. With `initialFocusValue`, that open-time focus moves
 * to the row with this value instead, so an immediate Enter keeps it rather than choosing the edge
 * row.
 */
export function useLadderPreview(datasetKey: string, options?: { initialFocusValue?: string }) {
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

  const attribute = datasetAttribute(datasetKey);
  const rowValue = (target: EventTarget | null) =>
    target instanceof Element
      ? (target.closest(`[${attribute}]`)?.getAttribute(attribute) ?? null)
      : null;
  const initialFocusValue = options?.initialFocusValue;

  const groupProps = {
    onPointerMoveCapture: (event: PointerEvent<HTMLElement>) => {
      navigatedRef.current = true;
      // Hovering the row that already has keyboard focus fires no new focus event.
      const value = rowValue(event.target);
      if (value !== null) setPreviewValue(value);
    },
    onFocus: (event: FocusEvent<HTMLElement>) => {
      const value = rowValue(event.target);
      if (navigatedRef.current) {
        setPreviewValue(value);
        return;
      }
      if (initialFocusValue === undefined || value === null || value === initialFocusValue) return;
      event.currentTarget
        .querySelector<HTMLElement>(`[${attribute}="${CSS.escape(initialFocusValue)}"]`)
        ?.focus({ preventScroll: true });
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
