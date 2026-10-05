import { XIcon } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "../../lib/utils";
import { basenameOfPath } from "../../vscode-icons";
import { VscodeEntryIcon } from "./VscodeEntryIcon";

const FILE_CHIP_CLASS_NAME =
  "inline-flex max-w-full min-w-0 items-center gap-1 rounded-md border border-border bg-muted/50 text-foreground";

const FILE_CHIP_SIZE_CLASS_NAME = {
  sm: "h-5 px-1 text-2xs",
  md: "h-6 px-1.5 text-ui",
} as const;

const FILE_CHIP_INTERACTIVE_CLASS_NAME =
  "outline-none transition-colors duration-(--duration-fast) hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring";

/**
 * One file reference chip: file-type icon, basename (full path in the
 * tooltip), and an optional remove button. Renders as a button when
 * `onClick` is set, a download link when `href` is set, otherwise a span.
 */
export function FileChip(props: {
  path: string;
  theme: "light" | "dark";
  label?: ReactNode;
  title?: string | undefined;
  size?: "sm" | "md";
  onClick?: (() => void) | undefined;
  href?: string | undefined;
  download?: string | undefined;
  onRemove?: (() => void) | undefined;
  removeLabel?: string | undefined;
  removeDisabled?: boolean | undefined;
  trailing?: ReactNode;
  className?: string | undefined;
}) {
  const size = props.size ?? "md";
  const title = props.title ?? props.path;
  const content = (
    <>
      <VscodeEntryIcon
        pathValue={props.path}
        kind="file"
        theme={props.theme}
        className={size === "sm" ? "size-3" : "size-3.5"}
      />
      <span className="min-w-0 truncate">{props.label ?? basenameOfPath(props.path)}</span>
      {props.trailing}
    </>
  );
  const baseClassName = cn(FILE_CHIP_CLASS_NAME, FILE_CHIP_SIZE_CLASS_NAME[size], props.className);

  if (props.onRemove) {
    return (
      <span className={baseClassName} title={title} data-slot="file-chip">
        {props.onClick ? (
          <button
            type="button"
            className="flex min-w-0 items-center gap-1 rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onClick={props.onClick}
          >
            {content}
          </button>
        ) : (
          content
        )}
        <button
          type="button"
          className="-me-0.5 inline-flex size-4 shrink-0 items-center justify-center rounded-sm text-muted-foreground outline-none hover:bg-background/70 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
          onClick={props.onRemove}
          disabled={props.removeDisabled}
          aria-label={props.removeLabel ?? `Remove ${title}`}
        >
          <XIcon className="size-3" />
        </button>
      </span>
    );
  }
  if (props.onClick) {
    return (
      <button
        type="button"
        className={cn(baseClassName, FILE_CHIP_INTERACTIVE_CLASS_NAME)}
        title={title}
        data-slot="file-chip"
        onClick={props.onClick}
      >
        {content}
      </button>
    );
  }
  if (props.href) {
    return (
      <a
        href={props.href}
        download={props.download}
        className={cn(baseClassName, FILE_CHIP_INTERACTIVE_CLASS_NAME)}
        title={title}
        data-slot="file-chip"
      >
        {content}
      </a>
    );
  }
  return (
    <span className={baseClassName} title={title} data-slot="file-chip">
      {content}
    </span>
  );
}
