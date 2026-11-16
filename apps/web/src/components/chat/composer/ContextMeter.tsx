import { BrainIcon, DatabaseIcon } from "lucide-react";

import { cn } from "~/lib/utils";

import type { PromptCacheMeterView } from "../../../lib/useThreadCacheTurns";
import { Popover, PopoverPopup, PopoverTrigger } from "../../ui/popover";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../ui/tooltip";
import { PromptCacheHistory } from "../PromptCacheHistory";
import {
  contextMeterTone,
  formatCompactTokens,
  formatExactTokens,
  resolveContextUsage,
  resolveLiveThinkingTokens,
  tokenUsageSourceLabel,
  type ComposerTokenUsage,
  type ContextMeterTone,
} from "./contextMeter.logic";

const RING_RADIUS = 6;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

const TONE_CLASS_NAME: Record<ContextMeterTone, string> = {
  muted: "text-muted-foreground",
  warning: "text-warning",
  destructive: "text-destructive",
};

function ContextRing(props: { ratio: number; tone: ContextMeterTone }) {
  const filled = Math.min(1, Math.max(0, props.ratio));
  return (
    <svg
      viewBox="0 0 16 16"
      className={cn("size-4 shrink-0 -rotate-90", TONE_CLASS_NAME[props.tone])}
      aria-hidden="true"
    >
      <circle cx="8" cy="8" r={RING_RADIUS} fill="none" strokeWidth="2" className="stroke-border" />
      <circle
        cx="8"
        cy="8"
        r={RING_RADIUS}
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeDasharray={RING_CIRCUMFERENCE}
        strokeDashoffset={RING_CIRCUMFERENCE * (1 - filled)}
      />
    </svg>
  );
}

const HOVER_DELAY_MS = 150;

/**
 * Context-window occupancy as a 16px ring in the composer footer. The tooltip
 * carries the exact numbers plus the live thinking-token estimate. With
 * `promptCache`, it also shows the thread's prompt cache history; that popup
 * opens on hover like the tooltip but holds buttons, so it is a popover. An
 * amber badge on the ring marks a last turn that missed the cache.
 */
export function ContextMeter(props: {
  tokenUsage: ComposerTokenUsage;
  promptCache?: PromptCacheMeterView | null;
  className?: string;
}) {
  const { tokenUsage } = props;
  const promptCache = props.promptCache ?? null;
  const context = resolveContextUsage(tokenUsage);
  const thinkingTokens = resolveLiveThinkingTokens(tokenUsage);
  if (!context && thinkingTokens === null && !promptCache) return null;

  const tone = context ? contextMeterTone(context.ratio) : "muted";
  const sourceLabel = tokenUsageSourceLabel(tokenUsage.tokenUsageSource);
  const lastTurnMissed = promptCache?.summary.last?.state === "miss";
  const ariaLabel = [
    context
      ? `Context window occupancy for ${tokenUsage.model}: ${context.label}`
      : thinkingTokens !== null
        ? "Live thinking-token estimate"
        : "Prompt cache history",
    lastTurnMissed ? "last turn missed the prompt cache" : null,
  ]
    .filter(Boolean)
    .join(", ");
  const triggerClassName = cn(
    "inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md px-1.5 text-2xs tabular-nums text-muted-foreground outline-none transition-colors duration-(--duration-fast) hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring data-popup-open:bg-accent",
    props.className,
  );

  const triggerContent = (
    <>
      {context || promptCache ? (
        <span className="relative inline-flex">
          {context ? (
            <ContextRing ratio={context.ratio} tone={tone} />
          ) : (
            <DatabaseIcon className="size-3.5" aria-hidden="true" />
          )}
          {lastTurnMissed ? (
            <span
              data-slot="prompt-cache-miss-badge"
              aria-hidden="true"
              className="absolute -top-0.5 -right-0.5 size-1.5 rounded-full bg-warning ring-2 ring-background"
            />
          ) : null}
        </span>
      ) : null}
      {thinkingTokens !== null ? (
        <span className="inline-flex items-center gap-1">
          <BrainIcon className="size-3.5 text-faint-foreground" aria-hidden="true" />
          {formatCompactTokens(thinkingTokens)} thinking
        </span>
      ) : null}
    </>
  );

  const details = (
    <div className="space-y-2 text-xs">
      {context ? (
        <div>
          <p className="font-medium text-foreground">Context {context.label}</p>
          <p className="text-muted-foreground">
            Used: {formatExactTokens(context.usedTokens)} tokens
          </p>
          <p className="text-muted-foreground">
            Window: {formatExactTokens(context.windowTokens)} tokens
          </p>
          <p className="text-muted-foreground">Model: {tokenUsage.model}</p>
          {sourceLabel ? <p className="text-muted-foreground">Source: {sourceLabel}</p> : null}
        </div>
      ) : null}
      {thinkingTokens !== null ? (
        <div>
          <p className="font-medium text-foreground">
            Thinking: ~{formatExactTokens(thinkingTokens)} tokens
          </p>
          <p className="text-muted-foreground">
            Approximate live estimate, not billed output tokens.
          </p>
        </div>
      ) : null}
      {promptCache ? (
        <div className={context || thinkingTokens !== null ? "border-t border-border pt-2" : ""}>
          <PromptCacheHistory view={promptCache} />
        </div>
      ) : null}
    </div>
  );

  if (promptCache) {
    return (
      <Popover>
        <PopoverTrigger
          openOnHover
          delay={HOVER_DELAY_MS}
          closeDelay={HOVER_DELAY_MS}
          aria-label={ariaLabel}
          data-slot="context-meter"
          data-tone={tone}
          className={triggerClassName}
        >
          {triggerContent}
        </PopoverTrigger>
        <PopoverPopup side="top" sideOffset={6} className="w-72 leading-tight">
          {details}
        </PopoverPopup>
      </Popover>
    );
  }

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={ariaLabel}
            data-slot="context-meter"
            data-tone={tone}
            className={triggerClassName}
          />
        }
      >
        {triggerContent}
      </TooltipTrigger>
      <TooltipPopup side="top" className="max-w-72 leading-tight">
        {details}
      </TooltipPopup>
    </Tooltip>
  );
}
