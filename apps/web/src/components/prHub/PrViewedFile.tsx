import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { PrHubComparisonIdentity, TrackedPullRequest } from "@t3tools/contracts";
import { ensureNativeApi } from "../../nativeApi";
import { getPrHubAccountGeneration } from "../../lib/prHubAccount";
export function PrViewedFile({
  pr,
  path,
  comparison,
}: {
  pr: TrackedPullRequest;
  path: string;
  comparison: PrHubComparisonIdentity;
}) {
  const generation = getPrHubAccountGeneration();
  const client = useQueryClient(),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null);
  const input = {
    key: pr.key,
    accountGeneration: generation,
    headOid: comparison.headOid,
    baseOid: comparison.baseOid,
  };
  const queryKey = [
    "prHub",
    "viewedFiles",
    generation,
    pr.key,
    comparison.headOid,
    comparison.baseOid,
  ];
  const query = useQuery({
    queryKey,
    queryFn: () => ensureNativeApi().prHub.getViewedFiles(input),
    enabled: !!pr.forgeCapabilities?.viewedFiles,
    staleTime: 60000,
    retry: false,
  });
  if (!pr.forgeCapabilities) return null;
  return (
    <label className="px-2 text-xs" title={error ?? query.error?.message}>
      <input
        type="checkbox"
        aria-label={`Viewed ${path}`}
        checked={query.data?.includes(path) ?? false}
        disabled={busy || query.isPending || query.isError}
        onChange={(e) => {
          setBusy(true);
          setError(null);
          void ensureNativeApi()
            .prHub.setViewedFile({ ...input, path, viewed: e.target.checked })
            .then(
              (value) => client.setQueryData(queryKey, value),
              (cause) =>
                setError(cause instanceof Error ? cause.message : "Could not save viewed mark."),
            )
            .finally(() => setBusy(false));
        }}
      />{" "}
      Viewed
    </label>
  );
}
