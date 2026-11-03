import { useId, useState } from "react";
import { cn } from "../../lib/utils";

export function ExpandableErrorText({
  text,
  collapsedText = text,
}: {
  text: string;
  collapsedText?: string;
}) {
  const textId = useId();
  const [expanded, setExpanded] = useState(false);
  const canExpand = collapsedText !== text || text.length > 180 || text.includes("\n");
  return (
    <div className="min-w-0">
      <div
        id={textId}
        className={cn("whitespace-pre-wrap break-words", !expanded && canExpand && "line-clamp-3")}
      >
        {expanded ? text : collapsedText}
      </div>
      {canExpand && (
        <button
          type="button"
          aria-controls={textId}
          aria-expanded={expanded}
          className="mt-1 text-xs underline underline-offset-2"
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? "Show less" : "Show full error"}
        </button>
      )}
    </div>
  );
}
