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
  /**
   * Identifies one Apply or Reconnect result. Retry results last until it changes, so a
   * parent that re-derives `outcomes` (filtering, a status refetch) keeps them. Defaults
   * to the `outcomes` array itself.
   */
  readonly resultKey?: unknown;
  readonly action: "apply" | "reconnect";
  /** Used for outcomes that do not name their own project. */
  readonly projectId: ProjectId | null;
  readonly instanceId: ProviderInstanceId;
  readonly serverName: string;
}) {
  const queryClient = useQueryClient();
  const resultKey = props.resultKey ?? props.outcomes;
  // A retry failure belongs to the result it was issued for; a newer result never shows it.
  const [failedRetry, setFailedRetry] = useState<{
    readonly base: unknown;
    readonly message: string;
  } | null>(null);
  const retryError = failedRetry && failedRetry.base === resultKey ? failedRetry.message : null;
  const [retrying, setRetrying] = useState(false);
  // Retry results replace only their own conversation's row, and only until the next
  // Apply or Reconnect delivers a new result.
  const [retried, setRetried] = useState<{
    readonly base: unknown;
    readonly byThread: ReadonlyMap<string, McpSessionReloadOutcome>;
  }>();
  const overrides = retried?.base === resultKey ? retried?.byThread : undefined;
  const outcomes = props.outcomes?.map((outcome) => overrides?.get(outcome.threadId) ?? outcome);
  if (!outcomes?.length && !retryError) return null;

  const retry = (outcome: McpSessionReloadOutcome) => {
    // A common-scope Apply returns conversations from several projects and accounts;
    // each is retried where it runs.
    const projectId = outcome.projectId ?? props.projectId;
    if (!projectId) return;
    setRetrying(true);
    setFailedRetry(null);
    const request =
      props.action === "reconnect"
        ? ensureNativeApi().mcp.reconnectServer({
            projectId,
            instanceId: outcome.instanceId,
            serverName: props.serverName,
            threadIds: [outcome.threadId],
          })
        : ensureNativeApi().mcp.applyToLiveSessions({
            scope: "project",
            projectId,
            instanceId: outcome.instanceId,
            threadIds: [outcome.threadId],
            retryUnchanged: true,
          });
    const base = resultKey;
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
      .catch((error) => setFailedRetry({ base, message: readErrorMessage(error, "Retry failed.") }))
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
          {outcome.disposition !== "applied" && (outcome.projectId ?? props.projectId) ? (
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
