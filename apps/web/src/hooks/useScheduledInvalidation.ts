import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ensureNativeApi } from "../nativeApi";
import { scheduledQueryKey } from "../lib/scheduledTasksQuery";
import { useWsConnectionState } from "../wsConnectionState";

/** One app-wide subscription keeps task names and management views current. */
export function useScheduledInvalidation() {
  const client = useQueryClient();
  const connection = useWsConnectionState();
  useEffect(
    () =>
      ensureNativeApi().scheduledTasks.onChanged(() => {
        void client.invalidateQueries({ queryKey: scheduledQueryKey });
      }),
    [client],
  );
  useEffect(() => {
    if (connection.synchronized) void client.invalidateQueries({ queryKey: scheduledQueryKey });
  }, [client, connection.synchronized, connection.connectedAt]);
}
