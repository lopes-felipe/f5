import type { ProviderKind } from "@t3tools/contracts";
import { estimateModelContextWindowTokens } from "@t3tools/shared/model";

export interface ComposerTokenUsage {
  estimatedContextTokens: number | null;
  estimatedThinkingTokens: number | null;
  modelContextWindowTokens: number | null;
  model: string;
  provider: ProviderKind | null;
  tokenUsageSource?: "provider" | "estimated" | null | undefined;
}

export type ContextMeterTone = "muted" | "warning" | "destructive";

export const CONTEXT_METER_WARNING_RATIO = 0.75;
export const CONTEXT_METER_DESTRUCTIVE_RATIO = 0.9;

/** Quiet until the window is three-quarters full, loud from 90%. */
export function contextMeterTone(ratio: number): ContextMeterTone {
  if (!Number.isFinite(ratio) || ratio < CONTEXT_METER_WARNING_RATIO) return "muted";
  if (ratio < CONTEXT_METER_DESTRUCTIVE_RATIO) return "warning";
  return "destructive";
}

const compactTokenFormatter = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 1,
});
const exactTokenFormatter = new Intl.NumberFormat("en-US");

export function formatCompactTokens(value: number): string {
  return compactTokenFormatter.format(value);
}

export function formatExactTokens(value: number): string {
  return exactTokenFormatter.format(value);
}

export interface ContextUsageSummary {
  usedTokens: number;
  windowTokens: number;
  ratio: number;
  percentage: number;
  /** e.g. "38K / 200K (19%)" */
  label: string;
}

export function resolveContextUsage(usage: ComposerTokenUsage): ContextUsageSummary | null {
  if (usage.estimatedContextTokens === null) return null;
  const windowTokens =
    usage.modelContextWindowTokens ??
    estimateModelContextWindowTokens(usage.model, usage.provider ?? undefined);
  const ratio = windowTokens > 0 ? usage.estimatedContextTokens / windowTokens : 0;
  const percentage = Math.round(ratio * 100);
  return {
    usedTokens: usage.estimatedContextTokens,
    windowTokens,
    ratio,
    percentage,
    label: `${formatCompactTokens(usage.estimatedContextTokens)} / ${formatCompactTokens(windowTokens)} (${percentage}%)`,
  };
}

export function resolveLiveThinkingTokens(usage: ComposerTokenUsage): number | null {
  const tokens = usage.estimatedThinkingTokens;
  return tokens !== null && tokens > 0 ? tokens : null;
}

export function tokenUsageSourceLabel(
  source: ComposerTokenUsage["tokenUsageSource"],
): string | null {
  if (source === "provider") return "Provider reported";
  if (source === "estimated") return "Locally estimated";
  return null;
}

/** One-line summary for the compact controls menu, or null when nothing is known. */
export function contextUsageSummaryLine(usage: ComposerTokenUsage): string | null {
  const context = resolveContextUsage(usage);
  const thinking = resolveLiveThinkingTokens(usage);
  const parts = [
    context ? `Context ${context.label}` : null,
    thinking !== null ? `${formatCompactTokens(thinking)} thinking` : null,
  ].filter((part): part is string => part !== null);
  return parts.length > 0 ? parts.join(" · ") : null;
}
