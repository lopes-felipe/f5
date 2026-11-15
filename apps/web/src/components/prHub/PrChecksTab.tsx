import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  AlertTriangleIcon,
  CheckCircle2Icon,
  ChevronRightIcon,
  CircleDashedIcon,
  CircleSlashIcon,
  ExternalLinkIcon,
  LoaderCircleIcon,
  MinusCircleIcon,
  XCircleIcon,
  type LucideIcon,
} from "lucide-react";
import type { PrHubCheckStatus, TrackedPullRequest } from "@t3tools/contracts";

import { prHubDetailQueryOptions } from "../../lib/prHubReactQuery";
import { cn } from "../../lib/utils";
import { OpenLinkAnchor } from "../OpenLinkAnchor";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  groupPrChecks,
  prCheckStatusLabel,
  prChecksSummary,
  type PrCheckGroup,
  type PrCheckGroupId,
} from "./prChecks";

const CHECK_ICON: Record<PrHubCheckStatus, { Icon: LucideIcon; className: string }> = {
  success: { Icon: CheckCircle2Icon, className: "text-success-foreground" },
  failure: { Icon: XCircleIcon, className: "text-destructive-foreground" },
  cancelled: { Icon: CircleSlashIcon, className: "text-destructive-foreground" },
  pending: { Icon: CircleDashedIcon, className: "text-info-foreground" },
  neutral: { Icon: MinusCircleIcon, className: "text-muted-foreground" },
  skipped: { Icon: MinusCircleIcon, className: "text-muted-foreground" },
};

/** The icon that says how a check ended, so a failed check does not look like a passed one. */
export function PrCheckStatusIcon({
  status,
  className,
}: {
  status: PrHubCheckStatus;
  className?: string;
}) {
  const { Icon, className: tone } = CHECK_ICON[status];
  return <Icon aria-hidden="true" className={cn("size-4 shrink-0", tone, className)} />;
}

/** Passed and skipped checks are rarely why someone opens the tab; they start folded. */
const FOLDED_BY_DEFAULT: ReadonlySet<PrCheckGroupId> = new Set(["passed", "skipped"]);

function CheckGroup({ group, onlyGroup }: { group: PrCheckGroup; onlyGroup: boolean }) {
  const [open, setOpen] = useState(onlyGroup || !FOLDED_BY_DEFAULT.has(group.id));
  const headingId = `pr-checks-${group.id}`;
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-1.5">
      <h3 id={headingId} className="text-sm font-semibold">
        <button
          type="button"
          aria-expanded={open}
          className="inline-flex items-center gap-1.5 rounded-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          onClick={() => setOpen(!open)}
        >
          <ChevronRightIcon
            aria-hidden="true"
            className={cn(
              "size-3.5 text-muted-foreground transition-transform",
              open && "rotate-90",
            )}
          />
          {group.label}
          <span className="font-normal text-muted-foreground tabular-nums">
            {group.checks.length}
          </span>
        </button>
      </h3>
      {open ? (
        <ul className="flex flex-col rounded-lg border border-border">
          {group.checks.map((check, index) => (
            <li
              key={`${check.name}:${index}`}
              className="flex min-w-0 items-center gap-2 border-b border-border px-3 py-2 text-sm last:border-b-0"
            >
              <PrCheckStatusIcon status={check.status} />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="flex min-w-0 items-center gap-1.5">
                  <span className="truncate text-foreground">{check.name}</span>
                  {check.required ? (
                    <Badge variant="outline" size="sm">
                      Required
                    </Badge>
                  ) : null}
                </span>
                {check.description ? (
                  <span className="truncate text-xs text-muted-foreground">
                    {check.description}
                  </span>
                ) : null}
              </span>
              <span className="shrink-0 text-xs text-muted-foreground">
                {prCheckStatusLabel(check.status)}
              </span>
              {check.url ? (
                <OpenLinkAnchor
                  href={check.url}
                  target="_blank"
                  rel="noreferrer"
                  aria-label={`Open ${check.name} on the forge`}
                  className="shrink-0 rounded-sm p-1 text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                >
                  <ExternalLinkIcon aria-hidden="true" className="size-3.5" />
                </OpenLinkAnchor>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

/** Every check of the pull request, grouped by outcome with the ones that block first. */
export function PrChecksTab({ pr }: { pr: TrackedPullRequest }) {
  const query = useQuery(prHubDetailQueryOptions(pr.key));
  if (query.isPending) {
    return (
      <div
        role="tabpanel"
        aria-label="Checks"
        className="flex items-center gap-2 py-4 text-sm text-muted-foreground"
      >
        <LoaderCircleIcon className="size-4 animate-spin" /> Loading checks…
      </div>
    );
  }
  if (query.isError) {
    return (
      <Alert variant="error" role="tabpanel" aria-label="Checks">
        <AlertTriangleIcon />
        <AlertTitle>Checks unavailable</AlertTitle>
        <AlertDescription>
          <span>
            {query.error instanceof Error ? query.error.message : "The checks could not be loaded."}
          </span>
          <Button size="xs" variant="outline" onClick={() => void query.refetch()}>
            Retry
          </Button>
        </AlertDescription>
      </Alert>
    );
  }
  const { checks, truncatedSections } = query.data.detail;
  const groups = groupPrChecks(checks);
  return (
    <div role="tabpanel" aria-label="Checks" className="flex flex-col gap-4">
      {truncatedSections?.includes("checks") ? (
        <Alert variant="warning">
          <AlertTriangleIcon />
          <AlertTitle>Some checks are not listed</AlertTitle>
          <AlertDescription>
            The forge returned only the first page of checks. Open the pull request on the forge to
            see all of them.
          </AlertDescription>
        </Alert>
      ) : null}
      {groups.length > 0 ? (
        <>
          <p className="text-sm text-muted-foreground">{prChecksSummary(checks)}</p>
          {groups.map((group) => (
            <CheckGroup key={group.id} group={group} onlyGroup={groups.length === 1} />
          ))}
        </>
      ) : (
        <p className="text-sm text-muted-foreground">No checks ran on this pull request.</p>
      )}
    </div>
  );
}
