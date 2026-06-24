import { queryOptions } from "@tanstack/react-query";
import type { PullRequestKey } from "@t3tools/contracts";

import { ensureNativeApi } from "../nativeApi";

export const prHubQueryKeys = {
  snapshot: ["prHub", "snapshot"] as const,
  advisories: (keys: readonly PullRequestKey[] = []) =>
    ["prHub", "advisories", [...keys].sort()] as const,
};

export function prHubSnapshotQueryOptions() {
  return queryOptions({
    queryKey: prHubQueryKeys.snapshot,
    queryFn: async () => ensureNativeApi().prHub.getSnapshot(),
    staleTime: 30_000,
  });
}

export function prHubAdvisoriesQueryOptions(keys: readonly PullRequestKey[] = []) {
  const sortedKeys = [...keys].sort();
  return queryOptions({
    queryKey: prHubQueryKeys.advisories(sortedKeys),
    queryFn: async () => ensureNativeApi().prHub.getAdvisories({ keys: sortedKeys }),
    staleTime: 30_000,
  });
}
