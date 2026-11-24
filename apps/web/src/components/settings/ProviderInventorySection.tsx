import type {
  ProjectId,
  ProviderInstanceId,
  ProviderInstanceInventory,
  ProviderInventoryHook,
  ProviderInventorySource,
} from "@t3tools/contracts";
import { withoutScratchProjects } from "@t3tools/shared/scratchProject";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDownIcon, RotateCwIcon } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode, type Ref } from "react";

import { cn } from "../../lib/utils";
import { ensureNativeApi } from "../../nativeApi";
import { useStore } from "../../store";
import {
  AlertDialog,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../ui/collapsible";
import { fieldSurfaceClassName } from "../ui/input";
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
  readonly action?: ReactNode;
  readonly error?: string | null;
  readonly groupRef?: Ref<HTMLDivElement>;
}) {
  return (
    <div className="space-y-1.5" ref={props.groupRef}>
      <div className="flex items-center justify-between gap-2">
        <h4 className="text-xs font-medium text-foreground">
          {props.title}
          <span className="ml-1.5 text-muted-foreground">{props.children.length}</span>
        </h4>
        {props.action}
      </div>
      {props.error ? (
        <p role="alert" className="whitespace-pre-wrap break-words text-xs text-destructive">
          {props.error}
        </p>
      ) : null}
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
  readonly badge?: ReactNode;
  readonly action?: ReactNode;
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
      {props.badge}
      <SourceBadge source={props.source} />
      {props.action}
    </li>
  );
}

const HOOK_EVENT_LABELS: Record<string, string> = {
  preModelRequest: "Before model request",
  postModelRequest: "After model request",
};

function hookEventLabel(event: string): string {
  return HOOK_EVENT_LABELS[event] ?? event;
}

/** Hooks the provider will not run until their current contents are approved. */
export function hookNeedsApproval(
  hook: ProviderInventoryHook,
): hook is ProviderInventoryHook & { key: string } {
  return (
    hook.key !== undefined &&
    hook.source !== "managed" &&
    (hook.trustStatus === "modified" || hook.trustStatus === "untrusted")
  );
}

function HookTrustDialog(props: {
  readonly hooks: ReadonlyArray<ProviderInventoryHook>;
  readonly pending: boolean;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
}) {
  const count = props.hooks.length;
  return (
    <AlertDialog
      open={count > 0}
      onOpenChange={(open) => {
        if (!open && !props.pending) props.onCancel();
      }}
    >
      <AlertDialogPopup>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {count === 1 ? "Trust this hook?" : `Trust these ${count} hooks?`}
          </AlertDialogTitle>
          <AlertDialogDescription>
            Trusted hooks run their commands on every matching event, with your permissions. Codex
            approves their current contents; if a plugin changes them again, they need approval
            again.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <ul className="mx-6 max-h-64 space-y-1.5 overflow-y-auto text-xs">
          {props.hooks.map((hook) => (
            <li key={hook.key} className="rounded-md border border-border/60 px-2.5 py-1.5">
              <div className="text-foreground">
                {hookEventLabel(hook.event)}
                {hook.matcher ? (
                  <span className="text-muted-foreground"> · {hook.matcher}</span>
                ) : null}
              </div>
              <div className="text-muted-foreground">
                {[hook.program, hook.pluginId].filter(Boolean).join(" · ") || "Unknown program"}
              </div>
              {hook.sourcePath ? (
                <div className="break-all font-mono text-2xs text-faint-foreground">
                  {hook.sourcePath}
                </div>
              ) : null}
            </li>
          ))}
        </ul>
        <AlertDialogFooter>
          <Button variant="outline" disabled={props.pending} onClick={props.onCancel}>
            Cancel
          </Button>
          <Button disabled={props.pending} onClick={props.onConfirm}>
            {props.pending ? <Spinner className="size-3" /> : null}
            {count === 1 ? "Trust hook" : `Trust ${count} hooks`}
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}

function HooksGroup(props: {
  readonly inventory: ProviderInstanceInventory;
  readonly focusHooks: boolean;
}) {
  const { inventory } = props;
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState<ReadonlyArray<ProviderInventoryHook>>([]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const groupRef = useRef<HTMLDivElement>(null);
  const trust = ensureNativeApi().server.trustProviderHooks;
  const approvable = trust ? inventory.hooks.filter(hookNeedsApproval) : [];

  useEffect(() => {
    if (props.focusHooks) groupRef.current?.scrollIntoView({ block: "start" });
  }, [props.focusHooks]);

  const confirm = () => {
    if (!trust) return;
    const keys = confirming.flatMap((hook) => (hook.key ? [hook.key] : []));
    setPending(true);
    setError(null);
    void trust({
      instanceId: inventory.instanceId,
      ...(inventory.projectId ? { projectId: inventory.projectId } : {}),
      keys,
    })
      .then(() => {
        setConfirming([]);
        return queryClient.invalidateQueries({
          queryKey: providerInventoryQueryKey(inventory.instanceId, inventory.projectId),
        });
      })
      .catch((cause: unknown) => {
        setConfirming([]);
        setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => setPending(false));
  };

  return (
    <>
      <InventoryGroup
        title="Hooks"
        empty="No hooks configured."
        groupRef={groupRef}
        error={error}
        action={
          approvable.length > 0 ? (
            <Button
              size="xs"
              variant="outline"
              disabled={pending}
              onClick={() => setConfirming(approvable)}
            >
              Trust all ({approvable.length})
            </Button>
          ) : null
        }
      >
        {inventory.hooks.map((hook, index) => {
          const needsApproval = trust !== undefined && hookNeedsApproval(hook);
          return (
            <InventoryRow
              key={hook.key ?? `${hook.sourcePath ?? hook.source}:${hook.event}:${index}`}
              title={
                <>
                  {hookEventLabel(hook.event)}
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
              badge={
                hookNeedsApproval(hook) ? (
                  <Badge
                    variant="warning"
                    size="sm"
                    className="shrink-0"
                    title={
                      hook.trustStatus === "modified"
                        ? "Its contents changed since you approved it. Codex will not run it."
                        : "Not reviewed yet. Codex will not run it."
                    }
                  >
                    Needs approval
                  </Badge>
                ) : null
              }
              action={
                needsApproval ? (
                  <Button
                    size="xs"
                    variant="outline"
                    className="shrink-0"
                    disabled={pending}
                    onClick={() => setConfirming([hook])}
                  >
                    Trust
                  </Button>
                ) : null
              }
            />
          );
        })}
      </InventoryGroup>
      <HookTrustDialog
        hooks={confirming}
        pending={pending}
        onCancel={() => setConfirming([])}
        onConfirm={confirm}
      />
    </>
  );
}

function InventoryBody({
  inventory,
  focusHooks,
}: {
  readonly inventory: ProviderInstanceInventory;
  readonly focusHooks: boolean;
}) {
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
      <HooksGroup inventory={inventory} focusHooks={focusHooks} />
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
 * with the place they come from. The one exception is trust: hooks Codex will
 * not run until their current contents are approved can be trusted here,
 * through Codex's own API.
 */
export function ProviderInventorySection({
  instanceId,
  focusHooks = false,
}: {
  readonly instanceId: ProviderInstanceId;
  /** Open on mount (and when it turns true) scrolled to the hooks. */
  readonly focusHooks?: boolean;
}) {
  const projects = useStore((store) => store.projects);
  const [open, setOpen] = useState(focusHooks);
  const [focusedOpen, setFocusedOpen] = useState(focusHooks);
  if (focusHooks !== focusedOpen) {
    setFocusedOpen(focusHooks);
    if (focusHooks) setOpen(true);
  }
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
              Read-only, except approving changed hooks. Manage the rest with the provider's own
              tools.
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
                    const save = ensureNativeApi().server.saveProviderFeedback;
                    if (!save) {
                      setSavingFeedback(false);
                      setFeedbackError("Feedback save is unavailable.");
                      return;
                    }
                    void save({ instanceId })
                      .then((result) => setFeedbackPath(result.path))
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
                className={cn(fieldSurfaceClassName, "h-7 min-w-0 flex-1 px-2 text-xs")}
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
              <InventoryBody inventory={query.data} focusHooks={focusHooks} />
            ) : (
              <p className="text-xs text-muted-foreground">Loading…</p>
            )}
          </div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
}
