import type { ProviderUsageWindow } from "@t3tools/contracts";

/** Keep conservative quota readings when endpoints or partial snapshots disagree. */
export function mergeProviderUsageWindows(
  responses: ReadonlyArray<ReadonlyArray<ProviderUsageWindow>>,
): ReadonlyArray<ProviderUsageWindow> {
  const windows = new Map<string, ProviderUsageWindow>();
  for (const response of responses) {
    for (const window of response) {
      const previous = windows.get(window.id);
      if (!previous || window.usedPercent > previous.usedPercent) windows.set(window.id, window);
    }
  }
  return [...windows.values()];
}
