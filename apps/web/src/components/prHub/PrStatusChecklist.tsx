import type { TrackedPullRequest } from "@t3tools/contracts";

import { cn } from "../../lib/utils";
import { Badge } from "../ui/badge";
import { attentionVariant } from "./prHubPresentation";
import { prStatusChecklist, type PrChecklistActionKind } from "./prQueueModel";
import { PR_TONE_DOT } from "./PrQueueTable";

/**
 * What the pull request is waiting for, line by line, with the step that moves each line
 * forward. The peek and the Overview tab show the same list.
 */
export function PrStatusChecklist({
  pr,
  onAction,
  className,
}: {
  pr: TrackedPullRequest;
  /** Without it the list is read-only. */
  onAction?: ((kind: PrChecklistActionKind) => void) | undefined;
  className?: string;
}) {
  return (
    <section aria-label="Status" className={cn("flex min-w-0 flex-col gap-2", className)}>
      {pr.nextAction ? (
        <div className="flex flex-col gap-1">
          <Badge variant={attentionVariant(pr)} className="self-start">
            {pr.nextAction}
          </Badge>
          {pr.primaryReason ? (
            <p className="text-xs text-muted-foreground">{pr.primaryReason}</p>
          ) : null}
        </div>
      ) : null}
      <ul className="flex flex-col rounded-lg border border-border">
        {prStatusChecklist(pr).map((item) => (
          <li
            key={item.id}
            className="flex min-h-8 items-baseline gap-2 border-b border-border px-3 py-1.5 text-xs last:border-b-0"
          >
            <span
              aria-hidden="true"
              className={cn(
                "size-1.5 shrink-0 -translate-y-px rounded-full",
                PR_TONE_DOT[item.tone],
              )}
            />
            <span className="w-24 shrink-0 font-medium text-foreground">{item.label}</span>
            <span className="min-w-0 flex-1 text-muted-foreground">{item.detail}</span>
            {onAction && item.actions.length > 0 ? (
              <span className="flex max-w-3/5 shrink-0 flex-wrap justify-end gap-x-3 gap-y-1">
                {item.actions.map((action) => (
                  <button
                    key={action.kind}
                    type="button"
                    className="rounded-sm font-medium text-foreground underline-offset-2 hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                    onClick={() => onAction(action.kind)}
                  >
                    {action.label}
                  </button>
                ))}
              </span>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
