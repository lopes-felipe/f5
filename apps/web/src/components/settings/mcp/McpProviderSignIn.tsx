import {
  PROVIDER_DISPLAY_NAMES,
  type McpProjectServersConfig,
  type McpServerStatusEntry,
  type McpServerStatusesResult,
  type ProjectId,
  type ProviderInstanceId,
  type ProviderKind,
} from "@t3tools/contracts";
import { isMcpServerServedTo } from "@t3tools/shared/mcpTranslation";

import { Button } from "../../ui/button";
import { useMcpSignIn } from "./McpSignInButton";
import { readErrorMessage } from "./mcpSettingsHelpers";

function supportsCodexOauth(server: McpProjectServersConfig[string]): boolean {
  return (
    server.type === "http" ||
    typeof server.oauthClientId === "string" ||
    typeof server.oauthCallbackPort === "number" ||
    typeof server.oauthCallbackUrl === "string" ||
    typeof server.oauthResource === "string"
  );
}

/**
 * Codex and Claude keep their own sign-in until they move onto F5's hub. Codex signs
 * in per account; Claude signs in through the conversation settings are observing.
 */
export function McpProviderSignIn(props: {
  readonly provider: ProviderKind;
  readonly instanceId: ProviderInstanceId;
  readonly accountLabel: string;
  readonly projectId: ProjectId | null;
  readonly serverName: string;
  readonly server: McpProjectServersConfig[string];
  readonly serverStatus: McpServerStatusEntry | undefined;
  readonly observation: McpServerStatusesResult | undefined;
}) {
  const isCodex = props.provider === "codex";
  const isClaude = props.provider === "claudeAgent";
  const signIn = useMcpSignIn({
    provider: props.provider,
    instanceId: props.instanceId,
    projectId: props.projectId,
    serverName: props.serverName,
    threadId: isClaude ? props.observation?.threadId : undefined,
    enabled: isCodex || isClaude,
  });
  if (!isCodex && !isClaude) return null;
  const status = signIn.status;
  const mode = status?.mode ?? (supportsCodexOauth(props.server) ? "oauth" : "cli");
  const disabledReason =
    props.projectId === null
      ? `Choose a project in the settings scope to sign ${PROVIDER_DISPLAY_NAMES[props.provider]} in.`
      : props.server.enabled === false
        ? "Enable this server before signing in."
        : !isMcpServerServedTo(props.server, props.provider)
          ? `This server is turned off for ${PROVIDER_DISPLAY_NAMES[props.provider]}.`
          : isCodex && props.observation && props.observation.support !== "supported"
            ? "Codex MCP login requires MCP control/status support."
            : null;
  const label = isClaude
    ? signIn.pending
      ? "Waiting for sign-in…"
      : "Sign in"
    : signIn.pending
      ? mode === "oauth"
        ? "Connecting..."
        : "Logging in..."
      : mode === "oauth"
        ? "Connect"
        : "Login";
  const needsSignIn =
    props.serverStatus?.state === "needs-auth" || props.serverStatus?.state === "login-required";
  return (
    <section aria-label={`Sign-in for ${props.accountLabel}`} className="space-y-2 text-xs">
      <p className="font-medium text-foreground">{props.accountLabel}</p>
      <p className="text-muted-foreground">
        {needsSignIn
          ? "This account reports that the server needs sign-in."
          : props.serverStatus
            ? `Observed state: ${props.serverStatus.state}.`
            : "No observation for this server yet."}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="xs"
          variant="outline"
          disabled={disabledReason !== null || signIn.pending}
          title={disabledReason ?? undefined}
          onClick={signIn.start}
        >
          {label}
        </Button>
        {signIn.reopen ? (
          <Button size="xs" variant="outline" onClick={signIn.reopen}>
            Reopen sign-in
          </Button>
        ) : null}
      </div>
      {disabledReason ? <p className="text-muted-foreground">{disabledReason}</p> : null}
      {signIn.error ? <p className="text-destructive">{signIn.error}</p> : null}
      {status?.error ? <p className="text-destructive">{status.error}</p> : null}
      {status?.message ? <p className="text-muted-foreground">{status.message}</p> : null}
      {signIn.statusError ? (
        <p className="text-destructive">
          {readErrorMessage(signIn.statusError, "Failed to read MCP login status.")}
        </p>
      ) : null}
    </section>
  );
}
