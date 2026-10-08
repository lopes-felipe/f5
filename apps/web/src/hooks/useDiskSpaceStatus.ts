import type { DiskSpaceStatus } from "@t3tools/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";

import { ensureNativeApi, readNativeApi } from "../nativeApi";

export const diskSpaceQueryKey = ["storage", "disk-space"] as const;

/** Keep whichever status was checked last: a replayed push can be older than a fetch. */
export function newerDiskSpaceStatus(
  current: DiskSpaceStatus | undefined,
  next: DiskSpaceStatus,
): DiskSpaceStatus {
  return current === undefined || next.checkedAt >= current.checkedAt ? next : current;
}

/**
 * Free disk space on the volumes F5 and its providers write to. The server
 * pushes every significant change; the slow refetch covers a reconnect that
 * missed one.
 */
export function useDiskSpaceStatus(): DiskSpaceStatus | null {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: diskSpaceQueryKey,
    // A fetch can resolve after a newer push landed; keep the push then.
    queryFn: async () =>
      newerDiskSpaceStatus(
        queryClient.getQueryData<DiskSpaceStatus>(diskSpaceQueryKey),
        await ensureNativeApi().storage.getDiskSpace(),
      ),
    staleTime: 60_000,
    refetchInterval: 5 * 60_000,
    retry: false,
  });
  useEffect(() => {
    const api = readNativeApi();
    if (!api) return;
    return api.storage.onDiskSpaceUpdated((status) => {
      queryClient.setQueryData<DiskSpaceStatus>(diskSpaceQueryKey, (current) =>
        newerDiskSpaceStatus(current, status),
      );
    });
  }, [queryClient]);
  return query.data ?? null;
}
