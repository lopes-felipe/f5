import { useState } from "react";
import { ChevronDownIcon, SparklesIcon } from "lucide-react";
import type { PrHubAdvisory } from "@t3tools/contracts";

import { cn } from "../../lib/utils";
import { Badge } from "../ui/badge";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import {
  advisoryRecommendationLabel,
  advisoryStatusLabel,
  advisoryVariant,
  openExternalHttps,
  safeHttpsUrl,
} from "./prHubPresentation";

export function PrAdvisoryInline({
  advisory,
  defaultExpanded = false,
}: {
  advisory: PrHubAdvisory;
  defaultExpanded?: boolean;
}) {
  const [isExpanded, setIsExpanded] = useState(defaultExpanded);
  const statusLabel = advisoryStatusLabel(advisory);
  const hasDetails =
    advisory.findings.length > 0 || advisory.blockers.length > 0 || Boolean(advisory.errorMessage);

  const summaryRow = (
    <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs">
      <SparklesIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
      <Badge variant={advisoryVariant(advisory)}>
        {advisoryRecommendationLabel(advisory.recommendation)}
      </Badge>
      {statusLabel ? <Badge variant="outline">{statusLabel}</Badge> : null}
      {advisory.confidence > 0 ? (
        <span className="text-muted-foreground tabular-nums">{advisory.confidence}%</span>
      ) : null}
      <span className="min-w-0 flex-1 truncate text-muted-foreground">{advisory.summary}</span>
      {hasDetails ? (
        <CollapsibleTrigger
          render={
            <button
              type="button"
              className="inline-flex shrink-0 items-center gap-1 text-muted-foreground hover:text-foreground"
            />
          }
        >
          Details
          <ChevronDownIcon
            className={cn("size-3 transition-transform", isExpanded && "rotate-180")}
          />
        </CollapsibleTrigger>
      ) : null}
    </div>
  );

  if (!hasDetails) return summaryRow;

  return (
    <Collapsible open={isExpanded} onOpenChange={setIsExpanded} className="min-w-0">
      {summaryRow}
      <CollapsiblePanel>
        <div className="mt-2 space-y-2 text-xs text-muted-foreground">
          {advisory.blockers.length > 0 ? (
            <div className="flex flex-wrap items-center gap-1.5">
              <span>Blockers</span>
              {advisory.blockers.map((blocker) => (
                <Badge key={blocker} variant="outline" size="sm">
                  {blocker}
                </Badge>
              ))}
            </div>
          ) : null}
          {advisory.findings.length > 0 ? (
            <div className="space-y-1">
              {advisory.findings.slice(0, 6).map((finding) => {
                const safeUrl = safeHttpsUrl(finding.url);
                return (
                  <a
                    key={finding.id}
                    href={safeUrl ?? "#"}
                    className="block rounded-sm px-2 py-1 hover:bg-accent hover:text-foreground"
                    onClick={(event) => {
                      event.preventDefault();
                      void openExternalHttps(finding.url, "finding");
                    }}
                  >
                    <span className="font-medium text-foreground">
                      {finding.validity.replaceAll("_", " ")}
                    </span>
                    {finding.author ? ` by ${finding.author}` : ""}: {finding.summary}
                  </a>
                );
              })}
            </div>
          ) : null}
          {advisory.errorMessage ? <div>{advisory.errorMessage}</div> : null}
        </div>
      </CollapsiblePanel>
    </Collapsible>
  );
}
