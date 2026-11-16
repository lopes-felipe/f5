import { McpConfirmDialog, McpDraftNavigationGuard, useMcpDraftGuard } from "./McpDraftGuard";
import { setMcpToolEnabled } from "@t3tools/shared/mcpTools";
import { Switch } from "../../ui/switch";
import { onServerWelcome } from "../../../wsNativeApi";
import { useWsConnectionState } from "../../../wsConnectionState";
import { useThreadSummaries } from "../../../threadSelectors";
import { McpObservedGroup } from "./McpObservedGroup";
import { isMcpQueryAffected } from "../../../lib/mcpReactQuery";
import { useProfileState } from "../../../profileState";
import {
  type McpConfigScope,
  type McpSessionReloadOutcome,
  ThreadId,
  type McpCommonConfigResult,
  type McpProjectConfigResult,
  type McpProjectServersConfig,
  type ProjectId,
  type ProviderKind,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { formatMcpServersAsJson } from "@t3tools/shared/mcpConfig";
import {
  MAX_SERVER_COUNT,
  normalizeMcpServersRecord,
  mcpServerNameKey,
  validateMcpLayerWrite,
} from "@t3tools/shared/mcpValidation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { ensureNativeApi } from "../../../nativeApi";
import {
  mcpCommonConfigQueryOptions,
  mcpEffectiveConfigQueryOptions,
  mcpProjectConfigQueryOptions,
  mcpProviderStatusQueryOptions,
  mcpQueryKeys,
  mcpServerStatusesQueryOptions,
  resetMcpRuntimePolling,
} from "../../../lib/mcpReactQuery";
import { useCopyToClipboard } from "../../../hooks/useCopyToClipboard";
import { Button } from "../../ui/button";
import { Toggle, ToggleGroup } from "../../ui/toggle-group";
import { McpServerList } from "./McpServerList";
import { McpServerEditor } from "./McpServerEditor";
import { LazyMcpImportDialog as McpImportDialog } from "./LazyMcpImportDialog";
import { McpExport } from "./McpExport";
import { McpProviderStatusBadge } from "./McpStatus";
import {
  createEmptyDraft,
  toWritableProjectServers,
  hasAdvancedFields,
  draftFromServer,
  decodeDraftServer,
  type ServerDraft,
} from "./mcpDraft";
import {
  describeMcpApplyProblems,
  readErrorMessage,
  formatCodexCallbackSummary,
} from "./mcpSettingsHelpers";

type ProjectSummary = { readonly id: ProjectId; readonly name: string };
const EMPTY_PROJECT_SERVERS: McpProjectServersConfig = {};

export function McpServersSettings(props: {
  readonly selectedProject: ProjectSummary | null;
  readonly hasProjects: boolean;
  readonly codexBinaryPath: string;
  readonly codexHomePath: string;
  readonly claudeBinaryPath: string;
}) {
  const queryClient = useQueryClient();
  const { copyToClipboard, isCopied } = useCopyToClipboard({
    onError: (error: Error) => {
      console.error(error);
    },
  });
  const [selectedScope, setSelectedScope] = useState<McpConfigScope>(
    props.selectedProject ? "project" : "common",
  );
  const [selectedProvider, setSelectedProvider] = useState<ProviderKind>("codex");
  const accounts = useProfileState((state) => state.active?.providerAccounts);
  const [accountSelection, setAccountSelection] = useState<string>("");
  const matchingAccounts = accounts?.filter((account) => account.driver === selectedProvider) ?? [];
  const selectedInstanceId = ProviderInstanceId.make(
    matchingAccounts.find((account) => account.instanceId === accountSelection)?.instanceId ??
      matchingAccounts[0]?.instanceId ??
      selectedProvider,
  );
  const [editorEpoch, setEditorEpoch] = useState(0);
  const [editingServerName, setEditingServerName] = useState<string | null>(null);
  const [draft, setDraft] = useState<ServerDraft>(createEmptyDraft());
  const [formError, setFormError] = useState<string | null>(null);
  const [isAdvancedOpen, setIsAdvancedOpen] = useState(false);
  const [projectActionError, setProjectActionError] = useState<string | null>(null);
  const [savedContext, setSavedContext] = useState<string | null>(null);
  const [isApplying, setIsApplying] = useState(false);
  const [isSavingConfig, setIsSavingConfig] = useState(false);

  const selectedProject = props.selectedProject;
  const [draftBase, setDraftBase] = useState<ServerDraft>(draft);
  const dirty = JSON.stringify(draft) !== JSON.stringify(draftBase);
  const [removingServer, setRemovingServer] = useState<string | null>(null);
  const resetEditor = () => {
    setEditorEpoch((epoch) => epoch + 1);
    setRemovingServer(null);
    setEditingServerName(null);
    const empty = createEmptyDraft();
    setDraft(empty);
    setDraftBase(empty);
    setFormError(null);
    setProjectActionError(null);
    setIsAdvancedOpen(false);
  };
  const {
    requestChange,
    confirmDiscard,
    dialog: draftGuardDialog,
  } = useMcpDraftGuard(dirty, isSavingConfig, resetEditor);
  const latestEditor = useRef({
    draft,
    selectedProject,
    selectedScope,
    editingServerName,
    editorEpoch,
  });
  useEffect(() => {
    latestEditor.current = {
      draft,
      selectedProject,
      selectedScope,
      editingServerName,
      editorEpoch,
    };
  });
  const selectedProjectId = selectedProject?.id ?? null;

  const commonConfigQuery = useQuery(mcpCommonConfigQueryOptions());
  const projectConfigQuery = useQuery(
    mcpProjectConfigQueryOptions({
      projectId: selectedProjectId,
      enabled: selectedProject !== null,
    }),
  );
  const effectiveConfigQuery = useQuery(
    mcpEffectiveConfigQueryOptions({
      projectId: selectedProjectId,
      enabled: selectedProject !== null,
    }),
  );
  const connection = useWsConnectionState();
  const threads = useThreadSummaries();
  const observationContext = JSON.stringify([
    selectedProvider,
    selectedProjectId,
    selectedInstanceId,
  ]);
  const [conversationSelection, setConversationSelection] = useState<{
    context: string;
    threadId?: ThreadId;
  }>({ context: "" });
  const [applyOutcomes, setApplyOutcomes] = useState<ReadonlyArray<McpSessionReloadOutcome>>();
  const selectedThreadId =
    conversationSelection.context === observationContext
      ? conversationSelection.threadId
      : undefined;
  const serverStatusesQuery = useQuery(
    mcpServerStatusesQueryOptions({
      provider: selectedProvider,
      instanceId: selectedInstanceId,
      projectId: selectedProjectId,
      ...(selectedThreadId ? { threadId: selectedThreadId } : {}),
      ...(effectiveConfigQuery.data?.effectiveVersion
        ? { desiredVersion: effectiveConfigQuery.data.effectiveVersion }
        : {}),
      enabled: selectedProject !== null && Boolean(effectiveConfigQuery.data),
    }),
  );
  const claudeProviderStatusQuery = useQuery(
    mcpProviderStatusQueryOptions({
      provider: selectedProvider,
      instanceId: selectedInstanceId,
      projectId: selectedProjectId,
      enabled:
        selectedProvider === "claudeAgent" &&
        serverStatusesQuery.data?.source === "configurationCheck",
    }),
  );
  const providerStatusQuery = {
    data:
      selectedProvider === "claudeAgent" &&
      serverStatusesQuery.data?.source === "configurationCheck"
        ? claudeProviderStatusQuery.data
        : serverStatusesQuery.data
          ? {
              provider: selectedProvider,
              projectId: selectedProjectId!,
              support: serverStatusesQuery.data.support,
              available: serverStatusesQuery.data.support === "supported",
              authStatus: "unknown" as const,
              ...(serverStatusesQuery.data.supportMessage
                ? { supportMessage: serverStatusesQuery.data.supportMessage }
                : {}),
            }
          : undefined,
    isPending: serverStatusesQuery.isPending,
    error: serverStatusesQuery.error,
  };
  useEffect(() => setSavedContext(null), [selectedScope, selectedProjectId]);

  useEffect(() => {
    if (!selectedThreadId) return;
    const error = serverStatusesQuery.error;
    if (
      error &&
      /conversation is not running in this project and account|requested conversation is unavailable/i.test(
        readErrorMessage(error, ""),
      )
    )
      setConversationSelection({ context: observationContext });
  }, [serverStatusesQuery.error, observationContext, selectedThreadId]);

  useEffect(() => {
    if (!selectedProjectId && selectedScope === "project") {
      setSelectedScope("common");
    }
  }, [selectedProjectId, selectedScope]);

  const activeConfig =
    selectedScope === "common" ? commonConfigQuery.data : projectConfigQuery.data;
  const activeServers = activeConfig?.servers ?? EMPTY_PROJECT_SERVERS;
  const editedServerMissing =
    editingServerName !== null &&
    activeConfig !== undefined &&
    !Object.hasOwn(activeServers, editingServerName);
  const orderedServers = useMemo(
    () =>
      (Object.entries(activeServers) as Array<[string, McpProjectServersConfig[string]]>).toSorted(
        ([leftName], [rightName]) => leftName.localeCompare(rightName),
      ),
    [activeServers],
  );
  const effectiveJson =
    selectedProject && effectiveConfigQuery.data
      ? formatMcpServersAsJson(effectiveConfigQuery.data.servers)
      : "";
  const codexCallbackSummaryServers = effectiveConfigQuery.data?.servers ?? activeServers;
  const codexCallbackSummaryByName = useMemo(
    () =>
      new Map(
        orderedServers.map(([name, server]) => [
          name,
          formatCodexCallbackSummary(codexCallbackSummaryServers, name, server),
        ]),
      ),
    [codexCallbackSummaryServers, orderedServers],
  );
  const serverStatusByName = useMemo(
    () =>
      new Map(
        (serverStatusesQuery.data?.statuses ?? [])
          .filter((status) => !status.ownership || status.ownership === "managed")
          .map((status) => [status.name, status]),
      ),
    [serverStatusesQuery.data],
  );
  const overriddenServerNames = useMemo(() => {
    if (selectedScope !== "common" || !selectedProjectId) {
      return new Set<string>();
    }
    return new Set(Object.keys(projectConfigQuery.data?.servers ?? EMPTY_PROJECT_SERVERS));
  }, [projectConfigQuery.data, selectedProjectId, selectedScope]);
  const overriddenServersByName = useMemo(() => {
    if (selectedScope !== "common" || !selectedProjectId) {
      return new Map<string, McpProjectServersConfig[string]>();
    }
    return new Map(Object.entries(projectConfigQuery.data?.servers ?? EMPTY_PROJECT_SERVERS));
  }, [projectConfigQuery.data, selectedProjectId, selectedScope]);

  useEffect(
    () =>
      ensureNativeApi().mcp.onStatusUpdated((event) => {
        void queryClient.invalidateQueries({
          predicate: (query) => isMcpQueryAffected(query.queryKey, event),
        });
      }),
    [queryClient],
  );
  useEffect(
    () =>
      onServerWelcome(() => {
        void queryClient
          .cancelQueries({
            queryKey: mcpQueryKeys.all,
            predicate: (query) =>
              query.state.data === undefined && query.state.fetchStatus === "fetching",
          })
          .then(() => queryClient.invalidateQueries({ queryKey: mcpQueryKeys.all }));
      }),
    [queryClient],
  );

  const persistScopeServers = async (
    nextServers: McpProjectServersConfig,
    expectedVersion = selectedScope === "common"
      ? commonConfigQuery.data?.version
      : projectConfigQuery.data?.version,
  ): Promise<McpCommonConfigResult | McpProjectConfigResult> => {
    setProjectActionError(null);
    setIsSavingConfig(true);
    try {
      if (selectedScope === "common") {
        const result = await ensureNativeApi().mcp.replaceCommonConfig({
          expectedVersion,
          servers: nextServers,
        });
        setSavedContext(`${selectedScope}:${selectedProjectId}`);
        queryClient.setQueryData(mcpQueryKeys.commonConfig(), result);
        await queryClient.invalidateQueries({ queryKey: mcpQueryKeys.all });
        return result;
      }

      if (!selectedProject) {
        throw new Error("Select a project before editing project-scoped MCP servers.");
      }

      const result = await ensureNativeApi().mcp.replaceProjectConfig({
        projectId: selectedProject.id,
        expectedVersion,
        servers: nextServers,
      });
      setSavedContext(`${selectedScope}:${selectedProjectId}`);
      queryClient.setQueryData(mcpQueryKeys.projectConfig(selectedProject.id), result);
      await queryClient.invalidateQueries({ queryKey: mcpQueryKeys.all });
      return result;
    } finally {
      setIsSavingConfig(false);
    }
  };

  // Advanced field edits retain existing errors until another basic-field edit or save.
  const changeAdvancedDraft = (patch: Partial<ServerDraft>) => {
    setDraft((current) => ({ ...current, ...patch }));
  };

  const changeDraft = (patch: Partial<ServerDraft>) => {
    changeAdvancedDraft(patch);
    setFormError(null);
  };

  const beginCreate = () => requestChange(resetEditor);

  const beginEdit = (name: string, server: McpProjectServersConfig[string]) =>
    requestChange(() => {
      setEditorEpoch((epoch) => epoch + 1);
      setEditingServerName(name);
      const next = draftFromServer(name, server);
      setDraft(next);
      setDraftBase(next);
      setFormError(null);
      setProjectActionError(null);
      setIsAdvancedOpen(hasAdvancedFields(server));
    });

  const removeServer = (name: string) => {
    const nextServers = toWritableProjectServers(activeServers);
    delete nextServers[name];
    void persistScopeServers(normalizeMcpServersRecord(nextServers))
      .then(() => {
        if (
          latestEditor.current.editingServerName === name &&
          latestEditor.current.draft === draft
        ) {
          resetEditor();
        }
      })
      .catch((error) => {
        setProjectActionError(readErrorMessage(error, "Failed to remove MCP server."));
      });
  };

  const saveDraft = () => {
    try {
      if (editedServerMissing)
        throw new Error(
          "This server was removed from saved configuration. Choose Create from this draft to add it again.",
        );
      const submittedDraft = draft;
      const submittedProject = selectedProject;
      const submittedScope = selectedScope;
      const { name, server } = decodeDraftServer(draft);
      const nextServers = toWritableProjectServers(activeServers);
      const collision = Object.keys(nextServers).find(
        (other) =>
          other !== editingServerName && mcpServerNameKey(other) === mcpServerNameKey(name),
      );
      if (collision)
        throw new Error(
          `Server '${collision}' already uses this name. Names are case-insensitive.`,
        );
      if (
        editingServerName === null &&
        !nextServers[name] &&
        Object.keys(nextServers).length >= MAX_SERVER_COUNT
      ) {
        throw new Error(`You can save at most ${MAX_SERVER_COUNT} MCP servers per scope.`);
      }
      if (editingServerName && editingServerName !== name) {
        delete nextServers[editingServerName];
      }
      nextServers[name] = server;
      const normalized = validateMcpLayerWrite(activeServers, nextServers);
      if (!normalized[name]) {
        throw new Error("The MCP server configuration is invalid.");
      }

      setFormError(null);
      void persistScopeServers(normalized)
        .then((result) => {
          if (
            latestEditor.current.selectedProject !== submittedProject ||
            latestEditor.current.selectedScope !== submittedScope
          )
            return;
          const next = draftFromServer(name, result.servers[name] ?? server);
          // Inputs remain editable during I/O; a completed save cannot erase newer typing.
          setDraftBase(next);
          setEditingServerName(name);
          if (latestEditor.current.draft === submittedDraft) setDraft(next);
          else
            setDraft((current) => ({
              ...current,
              ...(next.original ? { original: next.original } : {}),
            }));
        })
        .catch((error) => {
          setFormError(readErrorMessage(error, "Failed to save MCP server."));
        });
    } catch (error) {
      setFormError(readErrorMessage(error, "Failed to save MCP server."));
    }
  };

  const toggleServerEnabled = (name: string, checked: boolean) => {
    const nextServers = toWritableProjectServers(activeServers);
    const targetEpoch = editorEpoch;
    const currentServer = nextServers[name];
    if (!currentServer) {
      return;
    }
    nextServers[name] = { ...currentServer, enabled: checked };
    void persistScopeServers(normalizeMcpServersRecord(nextServers))
      .then(() => {
        if (
          latestEditor.current.editingServerName === name &&
          latestEditor.current.editorEpoch === targetEpoch
        ) {
          const mergeEnabled = (current: ServerDraft): ServerDraft => ({
            ...current,
            enabled: checked,
            ...(current.original
              ? {
                  original: {
                    ...current.original,
                    server: { ...current.original.server, enabled: checked },
                  },
                }
              : {}),
          });
          setDraft(mergeEnabled);
          setDraftBase(mergeEnabled);
        }
      })
      .catch((error) => {
        setProjectActionError(readErrorMessage(error, "Failed to update MCP server."));
      });
  };

  const handleExportJson = () => {
    if (!effectiveJson || !selectedProject) {
      return;
    }
    const filenameBase =
      selectedProject.name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "") || "mcp-config";
    const blob = new Blob([effectiveJson], {
      type: "application/json;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${filenameBase}.json`;
    anchor.click();
    window.setTimeout(() => {
      URL.revokeObjectURL(url);
    }, 0);
  };

  const applyToLiveSessions = () => {
    if (selectedScope === "project" && !selectedProject) {
      return;
    }
    setProjectActionError(null);
    setIsApplying(true);
    void ensureNativeApi()
      .mcp.applyToLiveSessions({
        scope: selectedScope,
        ...(selectedScope === "project" && selectedProject?.id
          ? { projectId: selectedProject.id }
          : {}),
      })
      .then(async (result) => {
        setSavedContext(null);
        setApplyOutcomes(result.sessions);
        const notice = describeMcpApplyProblems(result);
        if (notice) setProjectActionError(notice);
        await queryClient.invalidateQueries({ queryKey: mcpQueryKeys.all });
      })
      .catch((error) => {
        setProjectActionError(
          readErrorMessage(error, "Failed to apply MCP configuration to live sessions."),
        );
      })
      .finally(() => {
        setIsApplying(false);
      });
  };

  return (
    <section
      className="rounded-xl border border-border bg-card p-5"
      data-settings-search-target="tools.mcp"
    >
      {draftGuardDialog}
      <McpDraftNavigationGuard confirmDiscard={confirmDiscard} />
      <McpConfirmDialog
        open={removingServer !== null}
        title={`Remove “${removingServer ?? ""}”?`}
        description={`Remove this server from ${selectedScope === "common" ? "common scope (all projects)" : `project scope (${selectedProject?.name ?? "this project"})`}? Running sessions keep their current configuration until it is applied.`}
        confirmLabel="Remove server"
        onCancel={() => setRemovingServer(null)}
        onConfirm={() => {
          const name = removingServer;
          setRemovingServer(null);
          if (name) {
            if (editingServerName === name && dirty) requestChange(() => removeServer(name));
            else removeServer(name);
          }
        }}
      />
      {(
        (selectedScope === "common"
          ? commonConfigQuery.data?.issues
          : projectConfigQuery.data?.issues) ?? []
      ).map((issue, index) => (
        <p key={index} role="status" className="mb-2 text-xs text-warning-foreground">
          {issue.message}
        </p>
      ))}
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 className="text-sm font-medium text-foreground">MCP servers</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            Configure MCP in a shared common scope or a project scope. Project entries override
            common entries with the same name when the server resolves the effective config.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <McpProviderStatusBadge
            provider={selectedProvider}
            status={providerStatusQuery.data}
            source={serverStatusesQuery.data?.source}
            isLoading={providerStatusQuery.isPending && !providerStatusQuery.data}
            isApplying={isApplying}
          />
          <Button
            size="xs"
            variant="outline"
            title={
              selectedScope === "common"
                ? "Apply common MCP configuration across all projects and accounts"
                : `Apply MCP configuration to all live sessions in ${selectedProject?.name ?? "this project"}`
            }
            disabled={(selectedScope === "project" && !selectedProject) || isApplying}
            onClick={applyToLiveSessions}
          >
            Apply to all live sessions
          </Button>
        </div>
      </div>

      <div className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-3">
          <label className="space-y-2">
            <span className="text-xs font-medium text-foreground">Scope</span>
            <ToggleGroup
              variant="outline"
              size="xs"
              value={[selectedScope]}
              onValueChange={(value) => {
                const nextScope = value[0];
                if (nextScope !== "common" && nextScope !== "project") {
                  return;
                }
                if (nextScope === "project" && !selectedProject) {
                  return;
                }
                if (nextScope === selectedScope) return;
                requestChange(() => {
                  setSelectedScope(nextScope);
                  resetEditor();
                });
              }}
            >
              <Toggle value="project" disabled={!selectedProject}>
                Project
              </Toggle>
              <Toggle value="common">Common</Toggle>
            </ToggleGroup>
          </label>

          <label className="space-y-2">
            <span className="text-xs font-medium text-foreground">Provider</span>
            <ToggleGroup
              variant="outline"
              size="xs"
              value={[selectedProvider]}
              onValueChange={(value) => {
                const nextProvider = value[0];
                if (nextProvider !== "codex" && nextProvider !== "claudeAgent") {
                  return;
                }
                if (nextProvider === selectedProvider) return;
                requestChange(() => {
                  setSelectedProvider(nextProvider);
                  resetEditor();
                });
              }}
            >
              <Toggle value="codex">Codex</Toggle>
              <Toggle value="claudeAgent">Claude</Toggle>
            </ToggleGroup>
          </label>

          {matchingAccounts.length > 1 && (
            <label className="space-y-2">
              <span className="text-xs font-medium">Provider account</span>
              <select
                aria-label="MCP provider account"
                value={selectedInstanceId}
                onChange={(event) => {
                  const next = event.target.value;
                  requestChange(() => {
                    setAccountSelection(next);
                    resetEditor();
                  });
                }}
                className="block rounded border bg-background p-2 text-sm"
              >
                {matchingAccounts.map((account) => (
                  <option key={account.instanceId} value={account.instanceId}>
                    {account.displayName}
                  </option>
                ))}
              </select>
            </label>
          )}
          {selectedProject ? (
            <div className="space-y-2">
              <span className="text-xs font-medium text-foreground">Project</span>
              <div className="rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground">
                {selectedProject.name}
              </div>
            </div>
          ) : props.hasProjects ? null : (
            <p className="rounded-lg border border-dashed border-border bg-background px-3 py-2 text-xs text-muted-foreground">
              No projects yet. You can still edit common MCP configuration now.
            </p>
          )}
        </div>

        <p className="rounded-lg border border-border bg-background px-3 py-2 text-xs text-muted-foreground">
          Edit the shared MCP config once here. Provider switching only changes the live
          status/login pane, not the stored config.
        </p>

        {selectedProject === null ? (
          <p className="rounded-lg border border-dashed border-border bg-background px-3 py-2 text-xs text-muted-foreground">
            Switch the settings scope to a project to edit its servers, inspect provider-specific
            live status and the effective merged JSON, and sign in to servers that need it.
          </p>
        ) : null}

        {providerStatusQuery.data?.supportMessage ? (
          <p className="rounded-lg border border-border bg-background px-3 py-2 text-xs text-muted-foreground">
            {providerStatusQuery.data.supportMessage}
          </p>
        ) : null}
        {selectedProject ? (
          <div className="space-y-2 rounded-lg border border-border p-3 text-xs">
            <div className="flex flex-wrap items-center gap-2">
              <label className="flex items-center gap-2">
                Observe conversation
                <select
                  aria-label="Observed conversation"
                  value={selectedThreadId ?? ""}
                  className="rounded border border-border bg-background p-1"
                  onChange={(event) =>
                    setConversationSelection({
                      context: observationContext,
                      ...(event.target.value
                        ? { threadId: ThreadId.make(event.target.value) }
                        : {}),
                    })
                  }
                >
                  <option value="">Automatic selection</option>
                  {serverStatusesQuery.data?.sessions?.map((session) => (
                    <option key={session.threadId} value={session.threadId}>
                      {threads.find((thread) => thread.id === session.threadId)?.title ??
                        session.threadId}
                      {session.busy ? " (busy)" : ""}
                    </option>
                  ))}
                </select>
              </label>
              <Button
                size="xs"
                variant="outline"
                disabled={serverStatusesQuery.isFetching || connection.phase !== "connected"}
                onClick={() => {
                  resetMcpRuntimePolling(queryClient);
                  void serverStatusesQuery.refetch();
                }}
              >
                Refresh status
              </Button>
            </div>
            <p>
              {serverStatusesQuery.data?.source === "conversation"
                ? `Observed in ${threads.find((thread) => thread.id === serverStatusesQuery.data?.threadId)?.title ?? serverStatusesQuery.data.threadId} at ${serverStatusesQuery.data.observedAt ? new Date(serverStatusesQuery.data.observedAt).toLocaleTimeString() : "unknown time"}`
                : "Configuration check"}
            </p>
            {serverStatusesQuery.data?.source === "conversation" &&
            serverStatusesQuery.data.appliedVersion !== serverStatusesQuery.data.desiredVersion ? (
              <p>Saved changes are pending in this conversation.</p>
            ) : null}
            {selectedProvider === "claudeAgent" &&
            serverStatusesQuery.data?.source === "configurationCheck" ? (
              <p>
                Live status appears while a Claude session for this account runs in this project.
              </p>
            ) : null}
            {serverStatusesQuery.data?.complete === false ? (
              <p>Partial observation. Missing servers have unknown status.</p>
            ) : null}
            {serverStatusesQuery.data?.statuses.some((server) => server.state === "starting") ? (
              <p>Startup polling is limited to 30 seconds. Use Refresh status to check again.</p>
            ) : null}
          </div>
        ) : null}
        {(selectedScope === "common" ? commonConfigQuery.error : projectConfigQuery.error) ? (
          <p className="text-xs text-destructive">
            {readErrorMessage(
              selectedScope === "common" ? commonConfigQuery.error : projectConfigQuery.error,
              `Failed to load MCP ${selectedScope} configuration.`,
            )}
          </p>
        ) : null}
        {providerStatusQuery.error ? (
          <p className="text-xs text-destructive">
            {readErrorMessage(providerStatusQuery.error, "Failed to load MCP provider status.")}
          </p>
        ) : null}
        {serverStatusesQuery.error ? (
          <p className="text-xs text-destructive">
            {readErrorMessage(serverStatusesQuery.error, "Failed to load MCP server statuses.")}
          </p>
        ) : null}
        {effectiveConfigQuery.error ? (
          <p className="text-xs text-destructive">
            {readErrorMessage(
              effectiveConfigQuery.error,
              "Failed to load effective MCP configuration.",
            )}
          </p>
        ) : null}
        {projectActionError ? (
          <p className="text-xs text-destructive">{projectActionError}</p>
        ) : null}

        {selectedScope === "common" || selectedProject ? (
          <>
            {savedContext === `${selectedScope}:${selectedProjectId}` ? (
              <p role="status" className="rounded border p-3 text-xs">
                Saved. Running sessions pick up MCP changes on their next message, restarting if
                needed.{" "}
                <Button
                  size="xs"
                  variant="outline"
                  disabled={isApplying}
                  onClick={applyToLiveSessions}
                >
                  Apply to all live sessions
                </Button>
              </p>
            ) : null}
            {selectedScope === "project" ? (
              <div className="space-y-2">
                <p className="text-sm font-medium">Inherited from common</p>
                {Object.entries(commonConfigQuery.data?.servers ?? {})
                  .filter(([name]) => !Object.hasOwn(activeServers, name))
                  .map(([name, server]) => (
                    <div
                      key={name}
                      className="flex items-center justify-between gap-3 rounded border p-3 text-xs"
                    >
                      <span>{name}</span>
                      <label className="flex items-center gap-2">
                        Use in this project
                        <Switch
                          aria-label={`Use ${name} in this project`}
                          disabled={isSavingConfig}
                          checked={
                            !projectConfigQuery.data?.disabledCommonServers?.some(
                              (disabled) => mcpServerNameKey(disabled) === mcpServerNameKey(name),
                            )
                          }
                          onCheckedChange={(enabled) => {
                            if (!selectedProjectId) return;
                            const disabled = new Set(
                              (projectConfigQuery.data?.disabledCommonServers ?? []).filter(
                                (disabled) => mcpServerNameKey(disabled) !== mcpServerNameKey(name),
                              ),
                            );
                            if (enabled) disabled.delete(name);
                            else disabled.add(name);
                            setIsSavingConfig(true);
                            void ensureNativeApi()
                              .mcp.replaceProjectConfig({
                                projectId: selectedProjectId,
                                expectedVersion: projectConfigQuery.data?.version,
                                servers: activeServers,
                                disabledCommonServers: [...disabled],
                              })
                              .then((result) => {
                                setSavedContext(`${selectedScope}:${selectedProjectId}`);
                                queryClient.setQueryData(
                                  mcpQueryKeys.projectConfig(selectedProjectId),
                                  result,
                                );
                                return queryClient.invalidateQueries({
                                  queryKey: mcpQueryKeys.all,
                                });
                              })
                              .catch((cause) =>
                                setProjectActionError(
                                  readErrorMessage(cause, "Could not update inherited server."),
                                ),
                              )
                              .finally(() => setIsSavingConfig(false));
                          }}
                        />
                      </label>
                      <Button
                        size="xs"
                        variant="outline"
                        onClick={() => {
                          requestChange(() => {
                            resetEditor();
                            setDraft(draftFromServer(name, server));
                          });
                        }}
                      >
                        Override
                      </Button>
                    </div>
                  ))}
              </div>
            ) : null}
            <McpServerList
              selectedScope={selectedScope}
              observation={serverStatusesQuery.data}
              outcomes={applyOutcomes?.filter(
                (outcome) =>
                  outcome.instanceId === selectedInstanceId &&
                  serverStatusesQuery.data?.sessions?.some(
                    (session) => session.threadId === outcome.threadId,
                  ),
              )}
              orderedServers={orderedServers}
              beginCreate={beginCreate}
              isSavingConfig={isSavingConfig}
              isLoading={
                selectedScope === "common"
                  ? commonConfigQuery.isPending && !commonConfigQuery.data
                  : projectConfigQuery.isPending && !projectConfigQuery.data
              }
              selectedProvider={selectedProvider}
              selectedInstanceId={selectedInstanceId}
              projectId={selectedProjectId}
              providerStatus={providerStatusQuery.data}
              serverStatusByName={serverStatusByName}
              codexCallbackSummaryByName={codexCallbackSummaryByName}
              overriddenServerNames={overriddenServerNames}
              overriddenServersByName={overriddenServersByName}
              onToggleEnabled={toggleServerEnabled}
              beginEdit={beginEdit}
              removeServer={(name) => {
                if (!isSavingConfig) setRemovingServer(name);
              }}
              onToolToggle={async (name, tool, enabled) => {
                const server = activeServers[name];
                if (!server) throw new Error("Server no longer exists.");
                await persistScopeServers({
                  ...activeServers,
                  [name]: setMcpToolEnabled(server, tool, enabled),
                });
              }}
            />
            <McpObservedGroup
              group="managed"
              servers={effectiveConfigQuery.data?.servers ?? activeServers}
              removedNames={
                serverStatusesQuery.data?.statuses
                  .filter(
                    (status) =>
                      status.ownership === "managed" &&
                      !Object.keys(effectiveConfigQuery.data?.servers ?? {}).some(
                        (name) => mcpServerNameKey(name) === mcpServerNameKey(status.name),
                      ),
                  )
                  .map((status) => status.name) ?? []
              }
              observation={serverStatusesQuery.data}
              projectId={selectedProjectId}
              provider={selectedProvider}
              instanceId={selectedInstanceId}
            />
            <McpObservedGroup
              group="built-in"
              servers={effectiveConfigQuery.data?.servers ?? activeServers}
              observation={serverStatusesQuery.data}
              projectId={selectedProjectId}
              provider={selectedProvider}
              instanceId={selectedInstanceId}
            />
            <McpObservedGroup
              group="external"
              servers={effectiveConfigQuery.data?.servers ?? activeServers}
              observation={serverStatusesQuery.data}
              projectId={selectedProjectId}
              provider={selectedProvider}
              instanceId={selectedInstanceId}
            />
            {editedServerMissing ? (
              <div role="status" className="rounded border p-3 text-xs">
                This server was removed from saved configuration. Your draft is preserved. Saving is
                blocked until you explicitly create it again.
                <Button
                  size="xs"
                  variant="outline"
                  onClick={() => setEditingServerName(null)}
                  disabled={isSavingConfig}
                >
                  Create from this draft
                </Button>
              </div>
            ) : null}
            <McpServerEditor
              key={`${selectedProjectId}:${selectedScope}:${selectedInstanceId}:${editingServerName}:${editorEpoch}`}
              projectId={selectedProjectId}
              instanceId={selectedInstanceId}
              editingServerName={editingServerName}
              draft={draft}
              onDraftChange={changeDraft}
              onAdvancedDraftChange={changeAdvancedDraft}
              formError={formError}
              isAdvancedOpen={isAdvancedOpen}
              onAdvancedOpenChange={setIsAdvancedOpen}
              isSavingConfig={isSavingConfig}
              saveBlocked={editedServerMissing}
              beginCreate={beginCreate}
              saveDraft={saveDraft}
            />
            <McpExport
              effectiveJson={effectiveJson}
              selectedProject={selectedProject}
              isCopied={isCopied}
              onCopy={() => copyToClipboard(effectiveJson, undefined)}
              handleExportJson={handleExportJson}
            />
            <McpImportDialog
              key={`${selectedScope}:${selectedProjectId}:${selectedInstanceId}`}
              scope={selectedScope}
              projectId={selectedProjectId}
              instanceId={selectedInstanceId}
              servers={
                selectedScope === "common"
                  ? (commonConfigQuery.data?.servers ?? {})
                  : (projectConfigQuery.data?.servers ?? {})
              }
              version={
                selectedScope === "common"
                  ? commonConfigQuery.data?.version
                  : projectConfigQuery.data?.version
              }
              onImport={persistScopeServers}
              onRefreshBase={() => queryClient.invalidateQueries({ queryKey: mcpQueryKeys.all })}
            />
          </>
        ) : (
          <p className="rounded-lg border border-dashed border-border bg-background px-3 py-4 text-xs text-muted-foreground">
            Select a project to edit project-scoped MCP servers.
          </p>
        )}
      </div>
    </section>
  );
}
