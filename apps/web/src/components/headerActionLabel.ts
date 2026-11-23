/**
 * Label of a chat header action segment: screen-reader only (icon button) until
 * the header-actions container reaches `@xl`, then shown beside the icon.
 * `not-sr-only` resets `white-space` to `normal`, which lets a multi-word label
 * break; the segment's track can then be sized at the label's min-content while
 * the shrink-0 buttons still lay out on one line, pushing the trailing chevron
 * outside the track. Keep the label on one line.
 */
export const HEADER_ACTION_LABEL_CLASS_NAME =
  "sr-only @xl/header-actions:not-sr-only @xl/header-actions:ml-0.5 @xl/header-actions:whitespace-nowrap";
