/** Provider reset timestamps are epoch seconds; never render an invalid date. */
export function usageLimitMessage(
  provider: string,
  window: string | undefined,
  resetsAt: unknown,
): string {
  const milliseconds = typeof resetsAt === "number" ? resetsAt * 1000 : NaN;
  const reset =
    Number.isFinite(milliseconds) && milliseconds > 0 && milliseconds < 8.64e15
      ? ` Resets at ${new Date(milliseconds).toISOString()}.`
      : "";
  return `${provider} ${window ? `${window} ` : ""}usage limit reached.${reset} Retry after the limit resets.`;
}

export function claudeLimitState(info: Record<string, unknown>): {
  blocked: boolean;
  window: string;
  message: string;
  key: string;
} {
  const type = typeof info.rateLimitType === "string" ? info.rateLimitType : "unknown";
  const labels: Record<string, string> = {
    five_hour: "5-hour",
    seven_day: "7-day",
    seven_day_opus: "7-day Opus",
    seven_day_sonnet: "7-day Sonnet",
    seven_day_overage_included: "7-day model",
    overage: "overage",
  };
  const overage =
    info.overageStatus === "allowed" ||
    info.overageStatus === "allowed_warning" ||
    info.isUsingOverage === true ||
    info.overageInUse === true;
  return {
    blocked: info.status === "rejected" && !overage,
    window: type,
    key: `${type}:${info.resetsAt ?? "unknown"}`,
    message: usageLimitMessage("Claude", labels[type], info.resetsAt),
  };
}
