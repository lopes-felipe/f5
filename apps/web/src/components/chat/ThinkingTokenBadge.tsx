import { BrainIcon } from "lucide-react";

import { cn } from "~/lib/utils";

import { Badge } from "../ui/badge";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

const compactTokenFormatter = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 1,
});
const exactTokenFormatter = new Intl.NumberFormat("en-US");

export interface ThinkingTokenBadgeProps {
  estimatedThinkingTokens: number | null;
}

// Live "thinking tokens" pill. Unlike the context-window badge it has no
// percentage-of-window meaning (it is an approximate, ephemeral progress
// estimate emitted during extended thinking), so it uses a distinct neutral
// tone and is only rendered while a thinking estimate is actively counting up.
export default function ThinkingTokenBadge({ estimatedThinkingTokens }: ThinkingTokenBadgeProps) {
  if (estimatedThinkingTokens === null || estimatedThinkingTokens <= 0) {
    return null;
  }

  const badgeText = `${compactTokenFormatter.format(estimatedThinkingTokens)} thinking`;
  const tooltipText = [
    `Thinking: ~${exactTokenFormatter.format(estimatedThinkingTokens)} tokens`,
    "Approximate live estimate, not billed output tokens.",
  ].join("\n");

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Badge
            render={
              <button type="button" aria-label="Live thinking-token estimate" title={tooltipText} />
            }
            variant="outline"
            className={cn(
              "shrink-0 gap-1 font-normal",
              "border-violet-500/30 bg-violet-500/8 text-violet-700 dark:text-violet-300",
            )}
          >
            <BrainIcon className="size-3" />
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
