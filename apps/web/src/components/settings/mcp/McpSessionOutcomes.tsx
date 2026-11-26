import type { McpSessionReloadOutcome, ProjectId, ProviderInstanceId } from "@t3tools/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { mcpQueryKeys } from "../../../lib/mcpReactQuery";
import { ensureNativeApi } from "../../../nativeApi";
import { Button } from "../../ui/button";
import { readErrorMessage } from "./mcpSettingsHelpers";

/**
 * Per-conversation results of an Apply or Reconnect, with a retry for each conversation
 * that did not pick up the change.
 */
export function McpSessionOutcomes(props: {
  readonly outcomes: ReadonlyArray<McpSessionReloadOutcome> | undefined;
  readonly action: "apply" | "reconnect";
  readonly projectId: ProjectId | null;
  readonly instanceId: ProviderInstanceId;
  readonly serverName: string;
}) {
  const queryClient = useQueryClient();
  const [retryError, setRetryError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);
  // Retry results replace only their own conversation's row, and only until the next
  // Apply or Reconnect delivers a new list.
  const [retried, setRetried] = useState<{
    readonly base: ReadonlyArray<McpSessionReloadOutcome> | undefined;
    readonly byThread: ReadonlyMap<string, McpSessionReloadOutcome>;
  }>();
  const overrides = retried?.base === props.outcomes ? retried?.byThread : undefined;
  const outcomes = props.outcomes?.map((outcome) => overrides?.get(outcome.threadId) ?? outcome);
  if (!outcomes?.length && !retryError) return null;

  const retry = (outcome: McpSessionReloadOutcome) => {
    if (!props.projectId) return;
    setRetrying(true);
    setRetryError(null);
    const request =
      props.action === "reconnect"
        ? ensureNativeApi().mcp.reconnectServer({
            projectId: props.projectId,
            instanceId: props.instanceId,
            serverName: props.serverName,
            threadIds: [outcome.threadId],
          })
        : ensureNativeApi().mcp.applyToLiveSessions({
            scope: "project",
            projectId: props.projectId,
            instanceId: props.instanceId,
            threadIds: [outcome.threadId],
            retryUnchanged: true,
          });
    const base = props.outcomes;
    void request
      .then((result) => {
        setRetried((previous) => {
          const byThread = new Map(
            previous !== undefined && previous.base === base ? previous.byThread : [],
          );
          for (const session of result.sessions ?? []) byThread.set(session.threadId, session);
          return { base, byThread };
        });
        return queryClient.invalidateQueries({ queryKey: mcpQueryKeys.all });
      })
      .catch((error) => setRetryError(readErrorMessage(error, "Retry failed.")))
      .finally(() => setRetrying(false));
  };

  return (
    <div className="space-y-2">
      {outcomes?.map((outcome) => (
        <div key={`${outcome.threadId}:${outcome.generation}`} className="space-y-1 text-xs">
          <p>
            {outcome.threadId} · generation {outcome.generation}: {outcome.disposition}
          </p>
          {outcome.result.errors.map((error, index) => (
            <p key={index} className="whitespace-pre-wrap break-words">
              {error.message}
            </p>
          ))}
          {outcome.disposition !== "applied" ? (
            <Button size="xs" variant="outline" disabled={retrying} onClick={() => retry(outcome)}>
              Retry in this conversation
            </Button>
          ) : null}
        </div>
      ))}
      {retryError ? <p className="text-xs text-destructive">{retryError}</p> : null}
    </div>
  );
}
