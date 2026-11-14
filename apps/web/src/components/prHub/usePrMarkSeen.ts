import { useEffect } from "react";
import type { TrackedPullRequest } from "@t3tools/contracts";

import { getPrHubAccountGeneration } from "../../lib/prHubAccount";
import { ensureNativeApi } from "../../nativeApi";

/** Marks a pull request seen once it has stayed on screen, in a focused and visible window. */
export function usePrMarkSeen(pr: TrackedPullRequest | null): void {
  const accountGeneration = getPrHubAccountGeneration();
  const key = pr?.key;
  const fingerprint = pr?.attentionFingerprint;
  useEffect(() => {
    if (!accountGeneration || !key || !fingerprint) return;
    // A visible detail is seen; merely loading the queue never marks the collection.
    const timer = window.setTimeout(() => {
      if (!document.hasFocus() || document.visibilityState !== "visible") return;
      void ensureNativeApi()
        .prHub.markSeen({ key, attentionFingerprint: fingerprint, accountGeneration })
        .catch(() => {});
    }, 500);
    return () => window.clearTimeout(timer);
  }, [accountGeneration, key, fingerprint]);
}
