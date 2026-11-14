import { createElement } from "react";
import { ICON_PATHS } from "../contextMenuIcons";

export function ContextMenuIcon({ name }: { name?: string | undefined }) {
  const nodes = name ? ICON_PATHS[name] : undefined;
  if (!nodes) return null;
  return (
    <svg
      aria-hidden="true"
      className="size-4 shrink-0"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {nodes.map(({ tag, attrs }, index) => createElement(tag, { ...attrs, key: index }))}
    </svg>
  );
}
