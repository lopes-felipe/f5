import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { readNativeApi } from "../nativeApi";
import { scheduledQueryKey } from "../lib/scheduledTasksQuery";
import { useWsConnectionState } from "../wsConnectionState";

/** One app-wide subscription keeps task names and management views current. */
export function useScheduledInvalidation() {
  const client = useQueryClient();
  const connection = useWsConnectionState();
  useEffect(() => {
    // Hosts without the scheduled-tasks API (older bridges, route tests) skip the subscription.
    const scheduledTasks = readNativeApi()?.scheduledTasks;
    if (!scheduledTasks) return;
    return scheduledTasks.onChanged(() => {
      void client.invalidateQueries({ queryKey: scheduledQueryKey });
    });
  }, [client]);
  useEffect(() => {
    if (connection.synchronized) void client.invalidateQueries({ queryKey: scheduledQueryKey });
  }, [client, connection.synchronized, connection.connectedAt]);
}
