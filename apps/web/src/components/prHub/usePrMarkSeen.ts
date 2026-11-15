import { useEffect, useRef } from "react";
import type { TrackedPullRequest } from "@t3tools/contracts";

import { getPrHubAccountGeneration } from "../../lib/prHubAccount";
import { ensureNativeApi } from "../../nativeApi";

/** Marks a pull request seen once it has stayed on screen, in a focused and visible window. */
export function usePrMarkSeen(pr: TrackedPullRequest | null): void {
  const accountGeneration = getPrHubAccountGeneration();
  const key = pr?.key;
  const fingerprint = pr?.attentionFingerprint;
  // Activity that arrives while the pull request is on screen is seen as well.
  const changes = pr?.changesSinceSeen?.length ? JSON.stringify(pr.changesSinceSeen) : "";
  const sent = useRef<string | null>(null);
  useEffect(() => {
    if (!accountGeneration || !key || !fingerprint) return;
    const attention = `${key}\n${fingerprint}`;
    // Marking seen clears the changes, which runs this effect again. With this attention
    // already sent and nothing new since, there is nothing left to mark.
    if (sent.current === attention && !changes) return;
    // A visible detail is seen; merely loading the queue never marks the collection.
    const timer = window.setTimeout(() => {
      if (!document.hasFocus() || document.visibilityState !== "visible") return;
      sent.current = attention;
      void ensureNativeApi()
        .prHub.markSeen({ key, attentionFingerprint: fingerprint, accountGeneration })
        .catch(() => {
          if (sent.current === attention) sent.current = null;
        });
    }, 500);
    return () => window.clearTimeout(timer);
  }, [accountGeneration, key, fingerprint, changes]);
}
