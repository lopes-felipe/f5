import type {
  McpConfigScope,
  McpServerStatusesResult,
  McpSessionReloadOutcome,
  McpProjectServersConfig,
  McpProviderStatusResult,
  McpServerStatusEntry,
  ProjectId,
  ProviderInstanceId,
  ProviderKind,
} from "@t3tools/contracts";
import { MAX_SERVER_COUNT } from "@t3tools/shared/mcpValidation";
import { Button } from "../../ui/button";
import { McpServerRow } from "./McpServerRow";

export function McpServerList({
  selectedScope,
  observation,
  outcomes,
  orderedServers,
  beginCreate,
  isSavingConfig,
  isLoading,
  selectedProvider,
  selectedInstanceId,
  projectId,
  providerStatus,
  serverStatusByName,
  codexCallbackSummaryByName,
  overriddenServerNames,
  overriddenServersByName,
  onToggleEnabled,
  beginEdit,
  removeServer,
  onToolToggle,
}: {
  readonly onToolToggle: (serverName: string, toolName: string, enabled: boolean) => Promise<void>;
  readonly selectedScope: McpConfigScope;
  readonly observation?: McpServerStatusesResult | undefined;
  readonly outcomes?: ReadonlyArray<McpSessionReloadOutcome> | undefined;
  readonly orderedServers: ReadonlyArray<readonly [string, McpProjectServersConfig[string]]>;
  readonly beginCreate: () => void;
  readonly isSavingConfig: boolean;
  readonly isLoading: boolean;
  readonly selectedProvider: ProviderKind;
  readonly selectedInstanceId: ProviderInstanceId;
  readonly projectId: ProjectId | null;
  readonly providerStatus: McpProviderStatusResult | undefined;
  readonly serverStatusByName: ReadonlyMap<string, McpServerStatusEntry>;
  readonly codexCallbackSummaryByName: ReadonlyMap<string, string | null>;
  readonly overriddenServerNames: ReadonlySet<string>;
  readonly overriddenServersByName: ReadonlyMap<string, McpProjectServersConfig[string]>;
  readonly onToggleEnabled: (name: string, checked: boolean) => void;
  readonly beginEdit: (name: string, server: McpProjectServersConfig[string]) => void;
  readonly removeServer: (name: string) => void;
}) {
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-sm font-medium text-foreground">
          {selectedScope === "common" ? "Common servers" : "Project servers"} (
          {orderedServers.length}/{MAX_SERVER_COUNT})
        </p>
        <Button size="xs" variant="outline" onClick={beginCreate} disabled={isSavingConfig}>
          Add server
        </Button>
      </div>

      {isLoading ? (
        <p className="rounded-lg border border-dashed border-border bg-background px-3 py-4 text-xs text-muted-foreground">
          Loading MCP servers for this scope...
        </p>
      ) : orderedServers.length > 0 ? (
        <div className="space-y-3">
          {orderedServers.map(([name, server]) => (
            <McpServerRow
              key={`${selectedInstanceId}:${projectId}:${name}`}
              observation={observation}
              outcomes={outcomes}
              selectedProvider={selectedProvider}
              instanceId={selectedInstanceId}
              projectId={projectId}
              name={name}
              server={server}
              providerStatus={providerStatus}
              serverStatus={serverStatusByName.get(name)}
              codexCallbackSummary={
                selectedProvider === "codex" ? (codexCallbackSummaryByName.get(name) ?? null) : null
              }
              isOverridden={selectedScope === "common" && overriddenServerNames.has(name)}
              overrideTargetEnabled={overriddenServersByName.get(name)?.enabled !== false}
              onToggleEnabled={(checked) => onToggleEnabled(name, checked)}
              onEdit={() => beginEdit(name, server)}
              onRemove={() => removeServer(name)}
              onToolToggle={(toolName, enabled) => onToolToggle(name, toolName, enabled)}
            />
          ))}
        </div>
      ) : (
        <p className="rounded-lg border border-dashed border-border bg-background px-3 py-4 text-xs text-muted-foreground">
          No MCP servers configured for this scope.
        </p>
      )}
    </div>
  );
}
