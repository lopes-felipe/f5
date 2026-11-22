import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { TrackedPullRequest } from "@t3tools/contracts";
import { ensureNativeApi } from "../../nativeApi";
import { getPrHubAccountGeneration } from "../../lib/prHubAccount";
import { Tooltip, TooltipTrigger, TooltipPopup } from "../ui/tooltip";
import { ChangeBreakdownGrid } from "./ChangeBreakdownGrid";

export function PrChangeStat({
  pr,
  eager = false,
}: {
  pr: Pick<TrackedPullRequest, "key" | "additions" | "deletions" | "headRefOid">;
  eager?: boolean;
}) {
  const [requested, setRequested] = useState(false);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const cancelHover = () => clearTimeout(hoverTimer.current);
  useEffect(() => cancelHover, []);
  const accountGeneration = getPrHubAccountGeneration();
  const query = useQuery({
    queryKey: [
      "prHub",
      "changeBreakdown",
      accountGeneration,
      pr.key,
      pr.headRefOid,
      pr.additions,
      pr.deletions,
    ],
    queryFn: () => ensureNativeApi().prHub.getChangeBreakdown({ key: pr.key, accountGeneration }),
    enabled: eager || requested,
    staleTime: 30_000,
    retry: false,
  });
  const totals = query.data
    ? Object.values(query.data.breakdown).reduce(
        (sum, item) => ({
          additions: sum.additions + item.additions,
          deletions: sum.deletions + item.deletions,
        }),
        { additions: 0, deletions: 0 },
      )
    : null;
  // A push can land between the header read and the files read.
  const breakdown =
    query.data?.headOid === pr.headRefOid &&
    totals?.additions === pr.additions &&
    totals.deletions === pr.deletions
      ? query.data.breakdown
      : null;
  return (
    <Tooltip>
      <TooltipTrigger
        render={<span tabIndex={eager ? 0 : undefined} />}
        onPointerEnter={() => {
          cancelHover();
          hoverTimer.current = setTimeout(() => setRequested(true), 250);
        }}
        onPointerLeave={cancelHover}
        onFocus={eager ? () => setRequested(true) : undefined}
        className="inline-flex gap-1.5 font-mono tabular-nums"
      >
        <span className="text-success-foreground">+{pr.additions}</span>
        <span className="text-destructive-foreground">−{pr.deletions}</span>
      </TooltipTrigger>
      <TooltipPopup>
        {breakdown ? (
          <ChangeBreakdownGrid
            breakdown={breakdown}
            additions={pr.additions}
            deletions={pr.deletions}
          />
        ) : query.isFetching ? (
          "Loading breakdown…"
        ) : (
          "Breakdown unavailable"
        )}
      </TooltipPopup>
    </Tooltip>
  );
}
