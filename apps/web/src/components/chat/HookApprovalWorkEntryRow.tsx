import type { ThreadId } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { ChevronRightIcon, ShieldAlertIcon } from "lucide-react";
import { memo, useState, type ReactNode } from "react";

import { cn } from "../../lib/utils";
import { useStore } from "../../store";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";

/** Settings search that opens one instance's hooks, scoped to the thread's project. */
export function hookApprovalSettingsSearch(input: {
  readonly instanceId: string;
  readonly projectId?: string | undefined;
}) {
  return {
    category: "providers" as const,
    item: "providers.instances",
    instance: input.instanceId,
    ...(input.projectId ? { instanceProject: input.projectId } : {}),
  };
}

/**
 * One warning per turn for hooks Codex refused to run until their changed
 * contents are approved. The individual failures stay in the panel; the link
 * opens the provider instance that refused them in Settings, at its hooks for
 * the thread's project, where they can be trusted.
 */
export const HookApprovalWorkEntryRow = memo(function HookApprovalWorkEntryRow(props: {
  readonly label: string;
  readonly threadId: ThreadId | null;
  /** The instance that ran the hooks; falls back to the thread's current one. */
  readonly instanceId?: string | undefined;
  readonly children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const thread = useStore((store) =>
    props.threadId ? store.threads.find((candidate) => candidate.id === props.threadId) : undefined,
  );
  const instanceId =
    props.instanceId ?? thread?.session?.providerInstanceId ?? thread?.modelSelection?.instanceId;
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="rounded-md">
      <div className="flex min-h-6 w-full min-w-0 items-center gap-2 px-1 py-0.5">
        <CollapsibleTrigger
          className="flex min-w-0 flex-1 items-center gap-2 rounded-md text-left outline-none hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring"
          aria-label={`${props.label}. Show the failed hooks`}
        >
          <span className="flex size-5 shrink-0 items-center justify-center">
            <ShieldAlertIcon className="size-3.5 text-warning" />
          </span>
          <p className="min-w-0 flex-1 truncate text-ui leading-5 text-warning-foreground">
            {props.label}
          </p>
          <ChevronRightIcon
            className={cn(
              "size-3.5 shrink-0 text-faint-foreground transition-transform duration-(--duration-fast)",
              open && "rotate-90",
            )}
          />
        </CollapsibleTrigger>
        {instanceId ? (
          <Link
            to="/settings"
            search={hookApprovalSettingsSearch({ instanceId, projectId: thread?.projectId })}
            className="shrink-0 rounded-sm text-2xs text-muted-foreground underline outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          >
            Review hooks
          </Link>
        ) : null}
      </div>
      <CollapsiblePanel>
        <p className="ml-7 px-1 pb-1 text-2xs text-muted-foreground">
          Codex checks approvals when a session starts, so this conversation keeps skipping these
          hooks until its session restarts, even after you trust them.
        </p>
        {props.children}
      </CollapsiblePanel>
    </Collapsible>
  );
});
