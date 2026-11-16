import type { McpApplyToLiveSessionsResult, McpProjectServersConfig } from "@t3tools/contracts";
import { trimToUndefined } from "@t3tools/shared/mcpValidation";

export function readErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim().length > 0 ? error.message : fallback;
}

export function describeMcpApplyProblems(result: McpApplyToLiveSessionsResult): string | null {
  const failures = result.failures ?? [];
  const deferred = result.deferred ?? 0;
  const unconverged = failures.filter((failure) => !failure.restartRequired);
  const parts: string[] = [];
  if (deferred > 0) {
    parts.push(`${deferred} session(s) will restart with the new MCP config at their next turn.`);
  }
  if (unconverged.length > 0) {
    const details = unconverged
      .flatMap((failure) => failure.errors)
      .slice(0, 3)
      .map((error) => (error.server ? `${error.server}: ${error.message}` : error.message));
    parts.push(
      `${unconverged.length} session(s) did not fully apply the MCP config${
        details.length > 0 ? ` (${details.join("; ")})` : ""
      }.`,
    );
  }
  return parts.length > 0 ? parts.join(" ") : null;
}

export function formatCodexCallbackSummary(
  servers: McpProjectServersConfig,
  serverName: string,
  server: McpProjectServersConfig[string],
): string | null {
  const callbackEntries = Object.entries(servers).filter(
    ([, entry]) =>
      entry.enabled !== false &&
      (entry.oauthCallbackPort !== undefined || trimToUndefined(entry.oauthCallbackUrl)),
  );
  if (callbackEntries.length === 0) {
    return null;
  }

  const ports = [
    ...new Set(
      callbackEntries
        .map(([, entry]) => entry.oauthCallbackPort)
        .filter((port): port is number => port !== undefined),
    ),
  ];
  const urls = [
    ...new Set(
      callbackEntries
        .map(([, entry]) => trimToUndefined(entry.oauthCallbackUrl))
        .filter((url): url is string => url !== undefined),
    ),
  ];
  const parts = [
    ...(ports.length > 0 ? [`port ${ports.join(", ")}`] : []),
    ...(urls.length > 0 ? [`URL ${urls.join(", ")}`] : []),
  ];
  if (parts.length === 0) {
    return null;
  }

  const currentDefinesCallback =
    server.oauthCallbackPort !== undefined ||
    trimToUndefined(server.oauthCallbackUrl) !== undefined;
  const sourceNames = callbackEntries.map(([name]) => name).join(", ");
  return currentDefinesCallback
    ? `Codex OAuth callback: ${parts.join("; ")}.`
    : `Codex OAuth callback: ${parts.join("; ")} inherited from ${sourceNames} for ${serverName}.`;
}
