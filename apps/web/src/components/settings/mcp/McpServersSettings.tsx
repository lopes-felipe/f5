import { useProfileState } from "../../../profileState";
import {
  type McpConfigScope,
  type McpCommonConfigResult,
  type McpProjectConfigResult,
  type McpProjectServersConfig,
  type ProjectId,
  type ProviderKind,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { formatMcpServersAsJson } from "@t3tools/shared/mcpConfig";
import { parseImportedServers } from "@t3tools/shared/mcpImport";
import {
  MAX_SERVER_COUNT,
  normalizeMcpServersRecord,
  mcpServerNameKey,
  validateMcpLayerWrite,
} from "@t3tools/shared/mcpValidation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { ensureNativeApi } from "../../../nativeApi";
import {
  mcpCommonConfigQueryOptions,
  mcpEffectiveConfigQueryOptions,
  mcpProviderStatusQueryOptions,
  mcpProjectConfigQueryOptions,
  mcpQueryKeys,
  mcpServerStatusesQueryOptions,
} from "../../../lib/mcpReactQuery";
import { useCopyToClipboard } from "../../../hooks/useCopyToClipboard";
import { Button } from "../../ui/button";
import { Toggle, ToggleGroup } from "../../ui/toggle-group";
import { McpServerList } from "./McpServerList";
import { McpServerEditor } from "./McpServerEditor";
import { McpImport } from "./McpImport";
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
  const [editingServerName, setEditingServerName] = useState<string | null>(null);
  const [draft, setDraft] = useState<ServerDraft>(createEmptyDraft());
  const [formError, setFormError] = useState<string | null>(null);
  const [importText, setImportText] = useState("");
  const [importError, setImportError] = useState<string | null>(null);
  const [isAdvancedOpen, setIsAdvancedOpen] = useState(false);
  const [projectActionError, setProjectActionError] = useState<string | null>(null);
  const [isApplying, setIsApplying] = useState(false);
  const [isSavingConfig, setIsSavingConfig] = useState(false);

  const selectedProject = props.selectedProject;
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
  const providerStatusQuery = useQuery(
    mcpProviderStatusQueryOptions({
      provider: selectedProvider,
      instanceId: selectedInstanceId,
      projectId: selectedProjectId,

      enabled: selectedProject !== null,
    }),
  );
  const serverStatusesQuery = useQuery(
    mcpServerStatusesQueryOptions({
      provider: selectedProvider,
      instanceId: selectedInstanceId,
      projectId: selectedProjectId,

      enabled: selectedProject !== null,
    }),
  );

  useEffect(() => {
    if (!selectedProjectId && selectedScope === "project") {
      setSelectedScope("common");
    }
  }, [selectedProjectId, selectedScope]);

  useEffect(() => {
    setEditingServerName(null);
    setDraft(createEmptyDraft());
    setFormError(null);
    setImportError(null);
    setProjectActionError(null);
    setIsAdvancedOpen(false);
  }, [selectedProjectId]);

  const activeConfig =
    selectedScope === "common" ? commonConfigQuery.data : projectConfigQuery.data;
  const activeServers = activeConfig?.servers ?? EMPTY_PROJECT_SERVERS;
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
      new Map((serverStatusesQuery.data?.statuses ?? []).map((status) => [status.name, status])),
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

  useEffect(() => {
    if (selectedScope === "project" && !selectedProjectId) {
      setEditingServerName(null);
      setDraft(createEmptyDraft());
      setIsAdvancedOpen(false);
      return;
    }
    if (editingServerName && !activeServers[editingServerName]) {
      setEditingServerName(null);
      setDraft(createEmptyDraft());
      setIsAdvancedOpen(false);
    }
  }, [activeServers, editingServerName, selectedProjectId, selectedScope]);

  useEffect(
    () =>
      ensureNativeApi().mcp.onStatusUpdated(() => {
        void queryClient.invalidateQueries({ queryKey: mcpQueryKeys.all });
      }),
    [queryClient],
  );

  const persistScopeServers = async (
    nextServers: McpProjectServersConfig,
  ): Promise<McpCommonConfigResult | McpProjectConfigResult> => {
    setProjectActionError(null);
    setIsSavingConfig(true);
    try {
      if (selectedScope === "common") {
        const result = await ensureNativeApi().mcp.replaceCommonConfig({
          expectedVersion: commonConfigQuery.data?.version,
          servers: nextServers,
        });
        queryClient.setQueryData(mcpQueryKeys.commonConfig(), result);
        await queryClient.invalidateQueries({ queryKey: mcpQueryKeys.all });
        return result;
      }

      if (!selectedProject) {
        throw new Error("Select a project before editing project-scoped MCP servers.");
      }

      const result = await ensureNativeApi().mcp.replaceProjectConfig({
        projectId: selectedProject.id,
        expectedVersion: projectConfigQuery.data?.version,
        servers: nextServers,
      });
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

  const changeImportText = (text: string) => {
    setImportText(text);
    setImportError(null);
  };

  const beginCreate = () => {
    setEditingServerName(null);
    setDraft(createEmptyDraft());
    setFormError(null);
    setProjectActionError(null);
    setIsAdvancedOpen(false);
  };

  const beginEdit = (name: string, server: McpProjectServersConfig[string]) => {
    setEditingServerName(name);
    setDraft(draftFromServer(name, server));
    setFormError(null);
    setProjectActionError(null);
    setIsAdvancedOpen(hasAdvancedFields(server));
  };

  const removeServer = (name: string) => {
    const nextServers = toWritableProjectServers(activeServers);
    delete nextServers[name];
    void persistScopeServers(normalizeMcpServersRecord(nextServers))
      .then(() => {
        if (editingServerName === name) {
          beginCreate();
        }
      })
      .catch((error) => {
        setProjectActionError(readErrorMessage(error, "Failed to remove MCP server."));
      });
  };

  const saveDraft = () => {
    try {
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
          setEditingServerName(name);
          const savedServer = result.servers[name];
          setDraft(
            savedServer ? draftFromServer(name, savedServer) : draftFromServer(name, server),
          );
        })
        .catch((error) => {
          setFormError(readErrorMessage(error, "Failed to save MCP server."));
        });
    } catch (error) {
      setFormError(readErrorMessage(error, "Failed to save MCP server."));
    }
  };

  const importServers = () => {
    try {
      if (selectedScope === "project" && !selectedProject) {
        throw new Error("Select a project before importing project-scoped MCP servers.");
      }
      const imported = parseImportedServers(importText);
      if (Object.keys(imported).length === 0) {
        throw new Error("No importable MCP servers were found.");
      }

      const merged = normalizeMcpServersRecord({
        ...toWritableProjectServers(activeServers),
        ...imported,
      });
      validateMcpLayerWrite(activeServers, merged);

      setImportError(null);
      void persistScopeServers(merged)
        .then(() => {
          setImportText("");
        })
        .catch((error) => {
          setImportError(readErrorMessage(error, "Failed to import MCP servers."));
        });
    } catch (error) {
      setImportError(readErrorMessage(error, "Failed to import MCP servers."));
    }
  };

  const toggleServerEnabled = (name: string, checked: boolean) => {
    const nextServers = toWritableProjectServers(activeServers);
    const currentServer = nextServers[name];
    if (!currentServer) {
      return;
    }
    nextServers[name] = { ...currentServer, enabled: checked };
    void persistScopeServers(normalizeMcpServersRecord(nextServers))
      .then(() => {
        if (editingServerName === name) {
          setDraft((current) => ({ ...current, enabled: checked }));
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

  return (
    <section
      className="rounded-xl border border-border bg-card p-5"
      data-settings-search-target="tools.mcp"
    >
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
            isLoading={providerStatusQuery.isPending && !providerStatusQuery.data}
            isApplying={isApplying}
          />
          <Button
            size="xs"
            variant="outline"
            disabled={(selectedScope === "project" && !selectedProject) || isApplying}
            onClick={() => {
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
            }}
          >
            Apply to live sessions
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
                setSelectedScope(nextScope);
                setEditingServerName(null);
                setDraft(createEmptyDraft());
                setFormError(null);
                setImportError(null);
                setProjectActionError(null);
                setIsAdvancedOpen(false);
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
                setSelectedProvider(nextProvider);
                setProjectActionError(null);
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
                onChange={(event) => setAccountSelection(event.target.value)}
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
            Switch the settings scope to a project to edit its servers and inspect provider-specific
            live status and the effective merged JSON.
          </p>
        ) : null}

        {providerStatusQuery.data?.supportMessage ? (
          <p className="rounded-lg border border-border bg-background px-3 py-2 text-xs text-muted-foreground">
            {providerStatusQuery.data.supportMessage}
          </p>
        ) : null}
        {selectedProvider === "claudeAgent" ? (
          <p className="rounded-lg border border-border bg-background px-3 py-2 text-xs text-muted-foreground">
            Claude uses the same shared MCP config. Per-server Claude readiness is not surfaced here
            yet. If Claude shows <strong>Login required</strong>, run <code>claude auth login</code>{" "}
            in a terminal and then refresh this page.
          </p>
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
            <McpServerList
              selectedScope={selectedScope}
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
              removeServer={removeServer}
            />
            <McpServerEditor
              editingServerName={editingServerName}
              draft={draft}
              onDraftChange={changeDraft}
              onAdvancedDraftChange={changeAdvancedDraft}
              formError={formError}
              isAdvancedOpen={isAdvancedOpen}
              onAdvancedOpenChange={setIsAdvancedOpen}
              isSavingConfig={isSavingConfig}
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
            <McpImport
              importText={importText}
              onTextChange={changeImportText}
              importError={importError}
              isSavingConfig={isSavingConfig}
              importServers={importServers}
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
