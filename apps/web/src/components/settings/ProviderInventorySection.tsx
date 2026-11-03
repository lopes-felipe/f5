import type {
  ProjectId,
  ProviderInstanceId,
  ProviderInstanceInventory,
  ProviderInventorySource,
} from "@t3tools/contracts";
import { withoutScratchProjects } from "@t3tools/shared/scratchProject";
import { useQuery } from "@tanstack/react-query";
import { ChevronDownIcon, RotateCwIcon } from "lucide-react";
import { useState, type ReactNode } from "react";

import { cn } from "../../lib/utils";
import { ensureNativeApi } from "../../nativeApi";
import { useStore } from "../../store";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../ui/collapsible";
import { Spinner } from "../ui/spinner";

const SOURCE_LABELS: Record<ProviderInventorySource, string> = {
  project: "Project",
  local: "Local",
  instance: "Instance",
  managed: "Managed",
  plugin: "Plugin",
  unknown: "Unknown",
};

export function providerInventoryQueryKey(
  instanceId: ProviderInstanceId,
  projectId: ProjectId | undefined,
) {
  return ["provider-inventory", instanceId, projectId ?? null] as const;
}

function SourceBadge({ source }: { readonly source: ProviderInventorySource }) {
  return (
    <Badge variant="outline" size="sm" className="shrink-0">
      {SOURCE_LABELS[source]}
    </Badge>
  );
}

function InventoryGroup(props: {
  readonly title: string;
  readonly empty: string;
  readonly children: ReadonlyArray<ReactNode>;
}) {
  return (
    <div className="space-y-1.5">
      <h4 className="text-xs font-medium text-foreground">
        {props.title}
        <span className="ml-1.5 text-muted-foreground">{props.children.length}</span>
      </h4>
      {props.children.length === 0 ? (
        <p className="text-xs text-muted-foreground">{props.empty}</p>
      ) : (
        <ul className="divide-y divide-border/60 rounded-md border border-border/60">
          {props.children}
        </ul>
      )}
    </div>
  );
}

function InventoryRow(props: {
  readonly title: ReactNode;
  readonly detail?: ReactNode;
  readonly path?: string | undefined;
  readonly source: ProviderInventorySource;
  readonly disabled?: boolean;
}) {
  return (
    <li className={cn("flex items-start gap-2 px-2.5 py-1.5", props.disabled && "opacity-60")}>
      <div className="min-w-0 flex-1">
        <div className="truncate text-xs text-foreground">{props.title}</div>
        {props.detail ? (
          <div className="truncate text-xs text-muted-foreground">{props.detail}</div>
        ) : null}
        {props.path ? (
          <div className="truncate font-mono text-2xs text-faint-foreground" title={props.path}>
            {props.path}
          </div>
        ) : null}
      </div>
      <SourceBadge source={props.source} />
    </li>
  );
}

function InventoryBody({ inventory }: { readonly inventory: ProviderInstanceInventory }) {
  const hasAgents = inventory.driver === "claudeAgent";
  return (
    <div className="space-y-3">
      {inventory.account && (
        <p className="text-xs">
          {inventory.account.type === "gcp" ? "Google Vertex AI" : inventory.account.type}
          {inventory.account.email && (
            <span className="ml-2 blur-sm hover:blur-none">{inventory.account.email}</span>
          )}
          {inventory.account.workspaceName && (
            <span className="ml-2">{inventory.account.workspaceName}</span>
          )}
        </p>
      )}
      {inventory.accountWorkspaces && (
        <InventoryGroup title="Account workspaces" empty="No account workspaces reported.">
          {inventory.accountWorkspaces.map((workspace, index) => (
            <InventoryRow
              key={index}
              title={workspace.name}
              detail={[workspace.kind, workspace.active ? "Active" : null]
                .filter(Boolean)
                .join(" · ")}
              source="instance"
            />
          ))}
        </InventoryGroup>
      )}
      <InventoryGroup title="Hooks" empty="No hooks configured.">
        {inventory.hooks.map((hook, index) => (
          <InventoryRow
            key={`${hook.sourcePath ?? hook.source}:${hook.event}:${index}`}
            title={
              <>
                {(
                  {
                    preModelRequest: "Before model request",
                    postModelRequest: "After model request",
                  } as Record<string, string>
                )[hook.event] ?? hook.event}
                {hook.environmentId ? " · Environment (managed)" : ""}
                {hook.matcher ? (
                  <span className="text-muted-foreground"> · {hook.matcher}</span>
                ) : null}
              </>
            }
            detail={[hook.handlerType, hook.program, hook.pluginId].filter(Boolean).join(" · ")}
            path={hook.sourcePath}
            source={hook.source}
            disabled={hook.enabled === false}
          />
        ))}
      </InventoryGroup>
      <InventoryGroup title="Plugins" empty="No plugins installed.">
        {inventory.plugins.map((plugin) => (
          <InventoryRow
            key={`${plugin.source}:${plugin.id}`}
            title={plugin.name}
            detail={[plugin.marketplace, plugin.version, plugin.enabled === false ? "disabled" : ""]
              .filter(Boolean)
              .join(" · ")}
            path={plugin.sourcePath}
            source={plugin.source}
            disabled={plugin.enabled === false}
          />
        ))}
      </InventoryGroup>
      <InventoryGroup title="Connectors" empty="No MCP servers or connectors configured.">
        {inventory.connectors.map((connector, index) => (
          <InventoryRow
            key={`${connector.source}:${connector.name}:${index}`}
            title={connector.name}
            detail={[
              connector.kind,
              connector.status,
              connector.enabled === false ? "disabled" : "",
            ]
              .filter(Boolean)
              .join(" · ")}
            path={connector.sourcePath}
            source={connector.source}
            disabled={connector.enabled === false}
          />
        ))}
      </InventoryGroup>
      {hasAgents ? (
        <InventoryGroup title="Sub-agents" empty="No sub-agent definitions.">
          {inventory.agents.map((agent) => (
            <InventoryRow
              key={agent.definitionPath}
              title={agent.name}
              detail={
                agent.memoryScope
                  ? `Memory: ${agent.memoryScope}${agent.memoryExists ? "" : " (not created yet)"}`
                  : (agent.description ?? "No memory")
              }
              path={agent.memoryPath ?? agent.definitionPath}
              source={agent.source}
            />
          ))}
        </InventoryGroup>
      ) : null}
      {inventory.warnings.length > 0 ? (
        <ul className="space-y-0.5 text-xs text-warning-foreground">
          {inventory.warnings.map((warning, index) => (
            <li key={`${index}:${warning}`}>{warning}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/**
 * Read-only view of what the instance has configured. F5 does not install,
 * remove or edit hooks, plugins, connectors or agents; this only lists them
 * with the place they come from.
 */
export function ProviderInventorySection({
  instanceId,
}: {
  readonly instanceId: ProviderInstanceId;
}) {
  const projects = useStore((store) => store.projects);
  const [open, setOpen] = useState(false);
  const [projectId, setProjectId] = useState<ProjectId | undefined>(undefined);
  const [feedbackPath, setFeedbackPath] = useState<string | null>(null);
  const [feedbackError, setFeedbackError] = useState<string | null>(null);
  const [savingFeedback, setSavingFeedback] = useState(false);
  const query = useQuery({
    queryKey: providerInventoryQueryKey(instanceId, projectId),
    queryFn: () =>
      ensureNativeApi().server.getProviderInventory({
        instanceId,
        ...(projectId ? { projectId } : {}),
      }),
    enabled: open,
    staleTime: 30_000,
  });

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <div className="border-t border-border/60 px-4 py-3 sm:px-5">
        <CollapsibleTrigger className="flex w-full items-center justify-between gap-2 text-left">
          <span>
            <span className="block text-xs font-medium text-foreground">
              Hooks, plugins and connectors
            </span>
            <span className="block text-xs text-muted-foreground">
              Read-only. Manage these with the provider's own tools.
            </span>
          </span>
          <ChevronDownIcon
            aria-hidden="true"
            className={cn("size-4 shrink-0 transition-transform", open && "rotate-180")}
          />
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="mt-3 space-y-3">
            {query.data?.feedbackSupported && (
              <div className="space-y-2">
                <Button
                  variant="outline"
                  size="xs"
                  disabled={savingFeedback}
                  onClick={() => {
                    setSavingFeedback(true);
                    setFeedbackError(null);
                    void ensureNativeApi()
                      .server.getProviderInventory({ instanceId, saveFeedback: true })
                      .then((inventory) => setFeedbackPath(inventory.feedbackPath ?? null))
                      .catch((cause) => setFeedbackError(String(cause)))
                      .finally(() => setSavingFeedback(false));
                  }}
                >
                  Save Codex feedback bundle
                </Button>
                {feedbackPath && (
                  <p className="break-all text-xs">
                    {feedbackPath}{" "}
                    <Button
                      variant="ghost"
                      size="xs"
                      disabled={!window.desktopBridge?.revealFile}
                      onClick={() => {
                        void window.desktopBridge
                          ?.revealFile?.(feedbackPath)
                          .catch((cause) => setFeedbackError(String(cause)));
                      }}
                    >
                      Reveal
                    </Button>
                  </p>
                )}
                {feedbackError && (
                  <p role="alert" className="text-xs text-destructive">
                    {feedbackError}
                  </p>
                )}
              </div>
            )}
            <div className="flex items-center gap-2">
              <select
                aria-label="Project for project-shared entries"
                className="h-7 min-w-0 flex-1 rounded-md border border-input bg-background px-2 text-xs"
                value={projectId ?? ""}
                onChange={(event) =>
                  setProjectId(event.target.value ? (event.target.value as ProjectId) : undefined)
                }
              >
                <option value="">Instance only (no project)</option>
                {withoutScratchProjects(projects).map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.name}
                  </option>
                ))}
              </select>
              <Button
                size="xs"
                variant="outline"
                aria-label="Reload inventory"
                disabled={query.isFetching}
                onClick={() => void query.refetch()}
              >
                {query.isFetching ? <Spinner className="size-3" /> : <RotateCwIcon />}
              </Button>
            </div>
            {query.error ? (
              <p className="text-xs text-destructive-foreground">
                {query.error instanceof Error ? query.error.message : String(query.error)}
              </p>
            ) : query.data ? (
              <InventoryBody inventory={query.data} />
            ) : (
              <p className="text-xs text-muted-foreground">Loading…</p>
            )}
          </div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
}
