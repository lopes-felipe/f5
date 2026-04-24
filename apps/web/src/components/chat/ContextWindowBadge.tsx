import type { ProviderKind } from "@t3tools/contracts";
import { estimateModelContextWindowTokens } from "@t3tools/shared/model";

import { cn } from "~/lib/utils";

import { Badge } from "../ui/badge";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

const compactTokenFormatter = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 1,
});
const exactTokenFormatter = new Intl.NumberFormat("en-US");

function badgeToneClassName(percentage: number): string {
  if (percentage >= 70) {
    return "border-red-500/30 bg-red-500/8 text-red-700 dark:text-red-300";
  }
  if (percentage >= 45) {
    return "border-orange-500/30 bg-orange-500/8 text-orange-700 dark:text-orange-300";
  }
  if (percentage >= 20) {
    return "border-yellow-500/30 bg-yellow-500/8 text-yellow-700 dark:text-yellow-300";
  }
  return "border-emerald-500/30 bg-emerald-500/8 text-emerald-700 dark:text-emerald-300";
}

function tokenUsageSourceLabel(
  tokenUsageSource: "provider" | "estimated" | null | undefined,
): string | null {
  if (tokenUsageSource === "provider") {
    return "Provider reported";
  }
  if (tokenUsageSource === "estimated") {
    return "Locally estimated";
  }
  return null;
}

export interface ContextWindowBadgeProps {
  estimatedContextTokens: number | null;
  modelContextWindowTokens: number | null;
  model: string;
  provider: ProviderKind | null;
  tokenUsageSource?: "provider" | "estimated" | null | undefined;
}

export default function ContextWindowBadge({
  estimatedContextTokens,
  modelContextWindowTokens,
  model,
  provider,
  tokenUsageSource,
}: ContextWindowBadgeProps) {
  if (estimatedContextTokens === null) {
    return null;
  }

  const contextWindowTokens =
    modelContextWindowTokens ?? estimateModelContextWindowTokens(model, provider ?? undefined);
  const percentage = Math.round((estimatedContextTokens / contextWindowTokens) * 100);
  const sourceLabel = tokenUsageSourceLabel(tokenUsageSource);
  const badgeText = `${compactTokenFormatter.format(estimatedContextTokens)} / ${compactTokenFormatter.format(contextWindowTokens)} (${percentage}%)`;
  const tooltipText = [
    `Used: ${exactTokenFormatter.format(estimatedContextTokens)} tokens`,
    `Window: ${exactTokenFormatter.format(contextWindowTokens)} tokens`,
    `Model: ${model}`,
    ...(sourceLabel ? [`Source: ${sourceLabel}`] : []),
  ].join("\n");

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Badge
            render={
              <button
                type="button"
                aria-label={`Context window occupancy for ${model}`}
                title={tooltipText}
              />
            }
            variant="outline"
            className={cn("shrink-0 font-normal", badgeToneClassName(percentage))}
          >
            {badgeText}
          </Badge>
        }
      />
      <TooltipPopup side="bottom" className="max-w-72 whitespace-pre-wrap leading-tight">
        {tooltipText}
      </TooltipPopup>
    </Tooltip>
  );
}
