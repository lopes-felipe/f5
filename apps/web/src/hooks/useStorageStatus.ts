import type { StorageStatus, StorageGetUsageResult } from "@t3tools/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { ensureNativeApi } from "../nativeApi";
import { getWsConnectionState, subscribeWsConnectionState } from "../wsConnectionState";

export const storageStatusKey = ["storage", "status"] as const;
export const storageUsageKey = ["storage", "usage"] as const;
export function newerStorageStatus(
  current: StorageStatus | undefined,
  next: StorageStatus,
): StorageStatus {
  if (!current) return next;
  return current.backendEpoch === next.backendEpoch
    ? next.revision >= current.revision
      ? next
      : current
    : next.updatedAt >= current.updatedAt
      ? next
      : current;
}
export function newerStorageUsage(
  current: StorageGetUsageResult | undefined,
  next: StorageGetUsageResult,
): StorageGetUsageResult {
  if (!current) return next;
  if (newerStorageStatus(current.status, next.status) === current.status) return current;
  if (current.report && next.report && current.report.scannedAt > next.report.scannedAt)
    return { ...next, report: current.report, confirmation: null };
  if (current.report && next.report && current.report.scanId === next.report.scanId) {
    const loaded = new Map(current.report.categories.map((category) => [category.id, category]));
    return {
      ...next,
      report: {
        ...next.report,
        categories: next.report.categories.map((category) => {
          const targets = new Map(
            loaded.get(category.id)?.targets.map((target) => [target.id, target]),
          );
          for (const target of category.targets) targets.set(target.id, target);
          return { ...category, targets: [...targets.values()] };
        }),
      },
    };
  }
  return next;
}
export function useStorageStatus() {
  const client = useQueryClient();
  const query = useQuery({
    queryKey: storageStatusKey,
    queryFn: async () =>
      newerStorageStatus(
        client.getQueryData(storageStatusKey),
        await ensureNativeApi().storage.getStatus(),
      ),
    retry: false,
    refetchOnWindowFocus: false,
  });
  useEffect(() => {
    const unsubscribe = ensureNativeApi().storage.onStatusUpdated((next) => {
      const previous = client.getQueryData<StorageStatus>(storageStatusKey);
      const latest = newerStorageStatus(previous, next);
      client.setQueryData(storageStatusKey, latest);
      if (
        latest === next &&
        previous &&
        next.revision !== previous.revision &&
        next.scan.state === "idle" &&
        (!next.cleanup || next.cleanup.completedAt)
      )
        void client.invalidateQueries({ queryKey: storageUsageKey });
      if (
        latest === next &&
        next.cleanup?.completedAt &&
        !next.cleanup.result &&
        next.cleanup.completedAt !== previous?.cleanup?.completedAt
      )
        void client.invalidateQueries({ queryKey: storageStatusKey });
      if (
        latest === next &&
        ((previous?.scan.state === "scanning" && next.scan.state !== "scanning") ||
          (next.cleanup?.completedAt &&
            next.cleanup.completedAt !== previous?.cleanup?.completedAt))
      )
        void client.invalidateQueries({ queryKey: storageUsageKey });
    });
    const connection = subscribeWsConnectionState(() => {
      if (getWsConnectionState().synchronized) {
        void client.invalidateQueries({ queryKey: storageStatusKey });
        void client.invalidateQueries({ queryKey: storageUsageKey });
      }
    });
    return () => {
      unsubscribe();
      connection();
    };
  }, [client]);
  return query.data ?? null;
}
