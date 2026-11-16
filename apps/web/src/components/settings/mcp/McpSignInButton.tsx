import type { ProjectId, ProviderInstanceId, ProviderKind, ThreadId } from "@t3tools/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { ensureNativeApi } from "../../../nativeApi";
import { mcpLoginStatusQueryOptions, mcpQueryKeys } from "../../../lib/mcpReactQuery";
import { Button } from "../../ui/button";
import { readErrorMessage } from "./mcpSettingsHelpers";

/**
 * Explicit, user-initiated MCP sign-in. The browser opens only from `start` or `reopen`,
 * never because a server reported that it needs sign-in.
 */
export function useMcpSignIn(input: {
  readonly provider: ProviderKind;
  readonly instanceId?: ProviderInstanceId | undefined;
  readonly projectId: ProjectId | null;
  readonly serverName: string;
  /** Conversation that performs a session-routed (Claude) sign-in. */
  readonly threadId?: ThreadId | undefined;
  readonly enabled: boolean;
}) {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const statusQuery = useQuery(
    mcpLoginStatusQueryOptions({
      provider: input.provider,
      ...(input.instanceId ? { instanceId: input.instanceId } : {}),
      projectId: input.projectId,
      serverName: input.serverName,
      enabled: input.enabled && input.projectId !== null,
    }),
  );

  const openAuthorizationUrl = (url: string) =>
    ensureNativeApi()
      .shell.openExternal(url)
      .catch(() =>
        setError("Could not open the browser. Sign-in is still pending; use Reopen sign-in."),
      );

  const start = () => {
    if (!input.projectId || starting) return;
    setError(null);
    setStarting(true);
    void ensureNativeApi()
      .mcp.startLogin({
        provider: input.provider,
        ...(input.instanceId ? { instanceId: input.instanceId } : {}),
        projectId: input.projectId,
        serverName: input.serverName,
        ...(input.threadId ? { threadId: input.threadId } : {}),
      })
      .then(async (result) => {
        if (result.status === "pending" && result.authorizationUrl) {
          await openAuthorizationUrl(result.authorizationUrl);
        }
      })
      .catch((cause) => setError(readErrorMessage(cause, "Failed to start MCP sign-in.")))
      .finally(() => {
        setStarting(false);
        void queryClient.invalidateQueries({ queryKey: mcpQueryKeys.all });
      });
  };

  const status = statusQuery.data;
  return {
    status,
    statusError: statusQuery.error,
    error,
    setError,
    starting,
    pending: starting || status?.status === "pending",
    start,
    reopen:
      status?.status === "pending" && status.authorizationUrl
        ? () => void openAuthorizationUrl(status.authorizationUrl!)
        : undefined,
  };
}

/** Sign in button plus its pending, reopen, and error states. */
export function McpSignInControls(props: {
  readonly provider: ProviderKind;
  readonly instanceId?: ProviderInstanceId | undefined;
  readonly projectId: ProjectId | null;
  readonly serverName: string;
  readonly threadId?: ThreadId | undefined;
  readonly disabledReason?: string | null;
}) {
  const signIn = useMcpSignIn({
    provider: props.provider,
    instanceId: props.instanceId,
    projectId: props.projectId,
    serverName: props.serverName,
    threadId: props.threadId,
    enabled: true,
  });
  const disabledReason =
    props.disabledReason ?? (props.projectId === null ? "Select a project to sign in." : null);
  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="xs"
          variant="outline"
          disabled={disabledReason !== null || signIn.pending}
          title={disabledReason ?? undefined}
          aria-label={`Sign in to ${props.serverName}`}
          onClick={signIn.start}
        >
          {signIn.pending ? "Waiting for sign-in…" : "Sign in"}
        </Button>
        {signIn.reopen ? (
          <Button size="xs" variant="outline" onClick={signIn.reopen}>
            Reopen sign-in
          </Button>
        ) : null}
      </div>
      {signIn.error ? <p className="text-xs text-destructive">{signIn.error}</p> : null}
      {signIn.status?.status === "failed" && signIn.status.error ? (
        <p className="text-xs text-destructive">{signIn.status.error}</p>
      ) : null}
      {signIn.status?.status === "completed" && signIn.status.message ? (
        <p className="text-xs text-muted-foreground">{signIn.status.message}</p>
      ) : null}
    </div>
  );
}
