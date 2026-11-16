import type {
  ProviderKind,
  McpProviderStatusResult,
  McpServerStatusEntry,
  McpLoginStatusResult,
  McpServerStatusesResult,
} from "@t3tools/contracts";
import { Badge } from "../../ui/badge";

export function McpProviderStatusBadge({
  provider,
  status,
  isLoading,
  isApplying,
  source,
}: {
  readonly provider: ProviderKind;
  readonly status: McpProviderStatusResult | undefined;
  readonly isLoading: boolean;
  readonly isApplying: boolean;
  readonly source?: McpServerStatusesResult["source"];
}) {
  if (isApplying) {
    return <Badge variant="info">Applying...</Badge>;
  }
  if (isLoading) {
    return <Badge variant="outline">Checking...</Badge>;
  }
  if (!status) {
    return <Badge variant="outline">Unknown</Badge>;
  }

  if (source === "conversation") return <Badge variant="info">Live conversation</Badge>;
  switch (provider) {
    case "claudeAgent":
      if (!status.available) {
        return <Badge variant="error">Unavailable</Badge>;
      }
      if (status.authStatus === "authenticated") {
        return <Badge variant="success">Authenticated</Badge>;
      }
      if (status.authStatus === "unauthenticated") {
        return <Badge variant="warning">Login required</Badge>;
      }
      return <Badge variant="outline">Configured</Badge>;
    case "codex":
      if (status.support === "supported") {
        return <Badge variant="success">Control ready</Badge>;
      }
      if (status.support === "unsupported") {
        return <Badge variant="warning">Unsupported</Badge>;
      }
      return <Badge variant="error">Unavailable</Badge>;
  }
}

export function McpServerStatusBadge({
  provider,
  status,
  loginStatus,
  isOverridden,
}: {
  readonly provider: ProviderKind;
  readonly status: McpServerStatusEntry | undefined;
  readonly loginStatus: McpLoginStatusResult | undefined;
  readonly isOverridden?: boolean;
}) {
  if (isOverridden) {
    return <Badge variant="outline">Overridden</Badge>;
  }
  if (loginStatus?.status === "pending") {
    return (
      <Badge variant="info">{loginStatus.mode === "oauth" ? "Connecting" : "Logging in"}</Badge>
    );
  }
  if (!status) {
    return <Badge variant="outline">Unknown</Badge>;
  }
  if (
    provider === "claudeAgent" &&
    status.state === "unknown" &&
    status.message?.startsWith("Live status appears")
  ) {
    return <Badge variant="outline">Configured</Badge>;
  }
  switch (status.state) {
    case "disabled":
      return <Badge variant="warning">Disabled</Badge>;
    case "ready":
      return <Badge variant="success">Ready</Badge>;
    case "starting":
      return <Badge variant="info">Starting</Badge>;
    case "needs-auth":
    case "login-required":
      return <Badge variant="warning">Login required</Badge>;
    case "failed":
      return <Badge variant="error">Failed</Badge>;
    default:
      return <Badge variant="outline">Unknown</Badge>;
  }
}
