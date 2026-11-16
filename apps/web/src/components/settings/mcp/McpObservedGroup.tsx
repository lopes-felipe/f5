import { McpErrorDetails } from "./McpErrorDetails";
import type {
  McpServerStatusesResult,
  McpProjectServersConfig,
  ProjectId,
  ProviderInstanceId,
  ProviderKind,
} from "@t3tools/contracts";
import { createMcpDiagnosticsSanitizer } from "@t3tools/shared/mcpDiagnostics";
import { useState } from "react";
import { Button } from "../../ui/button";
import { LazyMcpServerInspector as McpServerInspector } from "./LazyMcpServerInspector";
import { McpSignInControls } from "./McpSignInButton";

export function McpObservedGroup(props: {
  servers: McpProjectServersConfig;
  group: "external" | "built-in" | "managed";
  observation?: McpServerStatusesResult | undefined;
  removedNames?: ReadonlyArray<string>;
  projectId: ProjectId | null;
  provider: ProviderKind;
  instanceId: ProviderInstanceId;
}) {
  const [inspected, setInspected] = useState<string | null>(null);
  const entries =
    props.observation?.statuses.filter(
      (server) =>
        server.ownership === props.group &&
        (props.group !== "managed" || props.removedNames?.includes(server.name)),
    ) ?? [];
  if (!entries.length) return null;
  return (
    <section className="space-y-2">
      <p className="text-sm font-medium">
        {props.group === "external"
          ? "External"
          : props.group === "built-in"
            ? "Built-in"
            : "Pending removal"}
      </p>
      {entries.map((entry, index) => (
        <div
          className="space-y-2 rounded-lg border border-border p-3 text-xs"
          key={`${entry.name}:${index}`}
        >
          <p>
            {entry.name} · {entry.state} ·{" "}
            {entry.origin ??
              (props.group === "built-in" ? "Registered by F5" : "Provider configuration")}
          </p>
          {entry.state === "ready" || entry.toolCount > 0 || entry.resourceCount > 0 ? (
            <p>
              {entry.toolCount} tools
              {props.provider !== "claudeAgent" ? ` · ${entry.resourceCount} resources` : ""}
            </p>
          ) : null}
          {entry.message ? (
            ["failed", "needs-auth", "login-required", "unknown"].includes(entry.state) ? (
              <McpErrorDetails message={entry.message} servers={props.servers} />
            ) : (
              <p className="whitespace-pre-wrap break-words text-muted-foreground">
                {createMcpDiagnosticsSanitizer(props.servers).text(entry.message)}
              </p>
            )
          ) : null}
          {props.group === "external" &&
          (props.provider === "claudeAgent" || props.provider === "codex") &&
          (entry.state === "needs-auth" || entry.state === "login-required") ? (
            <McpSignInControls
              provider={props.provider}
              instanceId={props.instanceId}
              projectId={props.projectId}
              serverName={entry.name}
              threadId={props.provider === "claudeAgent" ? props.observation?.threadId : undefined}
            />
          ) : null}
          {props.projectId ? (
            <Button
              size="xs"
              variant="outline"
              onClick={() =>
                setInspected((current) => (current === entry.name ? null : entry.name))
              }
            >
              Inspect {entry.name}
            </Button>
          ) : null}
          {inspected === entry.name && props.projectId ? (
            <McpServerInspector
              provider={props.provider}
              instanceId={props.instanceId}
              projectId={props.projectId}
              serverName={entry.name}
              ownership={props.group}
              observation={props.observation}
            />
          ) : null}
        </div>
      ))}
    </section>
  );
}
