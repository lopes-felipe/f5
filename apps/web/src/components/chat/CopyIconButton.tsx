import { CheckIcon, CopyIcon } from "lucide-react";
import type { MouseEvent } from "react";

import { cn } from "~/lib/utils";

/** Quiet icon-only copy action used in tool card section headers. */
export function CopyIconButton(props: {
  label: string;
  copied: boolean;
  onClick: (event: MouseEvent<HTMLButtonElement>) => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      className={cn(
        "flex size-5 items-center justify-center rounded-md text-muted-foreground outline-none transition-colors duration-(--duration-fast) hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
        props.className,
      )}
      aria-label={props.label}
      title={props.label}
      onClick={props.onClick}
    >
      {props.copied ? (
        <CheckIcon aria-hidden="true" className="size-3 text-success" />
      ) : (
        <CopyIcon aria-hidden="true" className="size-3" />
      )}
    </button>
  );
}
