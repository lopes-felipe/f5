import { queryOptions } from "@tanstack/react-query";
import { ensureNativeApi } from "../nativeApi";

export const scheduledQueryKey = ["scheduled-tasks"] as const;

export const scheduledTasksQueryOptions = () =>
  queryOptions({
    queryKey: scheduledQueryKey,
    queryFn: () => ensureNativeApi().scheduledTasks.list({}),
    staleTime: 5_000,
  });
