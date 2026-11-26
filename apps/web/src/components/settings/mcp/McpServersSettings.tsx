import {
  PROVIDER_DISPLAY_NAMES,
  ProviderInstanceId,
  ThreadId,
  type McpCommonConfigResult,
  type McpConfigScope,
  type McpHubServerStatus,
  type McpProjectConfigResult,
  type McpProjectServersConfig,
  type McpSessionReloadOutcome,
  type ProjectId,
  type ProviderKind,
} from "@t3tools/contracts";
import { formatMcpServersAsJson } from "@t3tools/shared/mcpConfig";
import { createMcpDiagnosticsSanitizer } from "@t3tools/shared/mcpDiagnostics";
import {
  MAX_SERVER_COUNT,
  mcpServerNameKey,
  normalizeMcpServersRecord,
  validateMcpLayerWrite,
} from "@t3tools/shared/mcpValidation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";

import { useCopyToClipboard } from "../../../hooks/useCopyToClipboard";
import {
  invalidateMcpConfigQueries,
  mcpCommonConfigQueryOptions,
  mcpEffectiveConfigQueryOptions,
  mcpHubStatusQueryOptions,
  mcpProjectConfigQueryOptions,
  mcpProviderStatusQueryOptions,
  mcpQueryKeys,
  mcpServerStatusesQueryOptions,
  resetMcpRuntimePolling,
} from "../../../lib/mcpReactQuery";
import { useMcpStatusUpdates } from "../../../lib/useMcpStatusUpdates";
import { ensureNativeApi } from "../../../nativeApi";
import { useProfileState } from "../../../profileState";
import { useThreadSummaries } from "../../../threadSelectors";
import { onServerWelcome } from "../../../wsNativeApi";
import { useWsConnectionState } from "../../../wsConnectionState";
import { Button } from "../../ui/button";
import { Dialog, DialogDescription, DialogPopup, DialogTitle } from "../../ui/dialog";
import { toastManager } from "../../ui/toast";
import { McpAddServerDialog, type McpAddTab } from "./McpAddServerDialog";
import { McpConfirmDialog, McpDraftNavigationGuard, useMcpDraftGuard } from "./McpDraftGuard";
import { McpExport } from "./McpExport";
import { McpHubNotice } from "./McpHubNotice";
import { McpObservedGroup } from "./McpObservedGroup";
import {
  McpServerDetailSheet,
  type McpDetailTab,
  type McpObservedAccount,
} from "./McpServerDetailSheet";
import { McpServerEditor } from "./McpServerEditor";
import { McpServerListRow, type McpRowAction } from "./McpServerListRow";
import { McpProviderStatusBadge } from "./McpStatus";
import { reconnectMcpServer } from "./mcpActions";
import {
  createEmptyDraft,
  decodeDraftServer,
  draftFromCatalog,
  draftFromServer,
  hasAdvancedFields,
  uniqueMcpServerName,
  rebaseDraft,
  toWritableProjectServers,
  type ServerDraft,
} from "./mcpDraft";
import {
  hubStatusSources,
  observedStatusSource,
  summarizeMcpServerStatus,
} from "./mcpServerStatus";
import { describeMcpApplyProblems, readErrorMessage } from "./mcpSettingsHelpers";

type ProjectSummary = { readonly id: ProjectId; readonly name: string };
type ServerEntry = readonly [string, McpProjectServersConfig[string]];
const EMPTY_SERVERS: McpProjectServersConfig = {};
const EMPTY_HUB: ReadonlyArray<McpHubServerStatus> = [];

interface AccountOption {
  readonly id: string;
  readonly provider: ProviderKind;
  readonly instanceId: ProviderInstanceId;
  readonly label: string;
}

function byName([left]: ServerEntry, [right]: ServerEntry) {
  return left.localeCompare(right);
}

function copyName(name: string, taken: ReadonlyArray<string>): string {
  const keys = new Set(taken.map(mcpServerNameKey));
  const base = `${name}_copy`.slice(0, 120);
  if (!keys.has(mcpServerNameKey(base))) return base;
  for (let index = 2; ; index++) {
    const candidate = `${base}_${index}`;
    if (!keys.has(mcpServerNameKey(candidate))) return candidate;
  }
}

/**
 * MCP servers for the settings scope: common servers in Global, or a project's own
 * servers plus the ones it inherits from common. Each server opens a detail panel;
 * Add server offers a form, pasted configuration, or detected configuration.
 */
export function McpServersSettings(props: {
  readonly selectedProject: ProjectSummary | null;
  readonly hasProjects: boolean;
  readonly projects?: ReadonlyArray<ProjectSummary>;
  /** A server to open in its detail panel, from a settings link. */
  readonly focusServer?: string | null | undefined;
}) {
  const queryClient = useQueryClient();
  const { copyToClipboard, isCopied } = useCopyToClipboard({
    onError: (error: Error) => console.error(error),
  });
  const selectedProject = props.selectedProject;
  const selectedProjectId = selectedProject?.id ?? null;
  const scope: McpConfigScope = selectedProject ? "project" : "common";
  const scopeLabel = selectedProject
    ? `project scope (${selectedProject.name})`
    : "common scope (all projects)";

  // Live Codex and Claude status comes from one observed account until they move onto
  // the hub; other agents' status comes from the hub.
  const accounts = useProfileState((state) => state.active?.providerAccounts);
  const accountOptions = useMemo<AccountOption[]>(() => {
    const options: AccountOption[] = [];
    for (const provider of ["codex", "claudeAgent"] as const) {
      const matching = accounts?.filter((account) => account.driver === provider) ?? [];
      if (!matching.length)
        options.push({
          id: provider,
          provider,
          instanceId: ProviderInstanceId.make(provider),
          label: PROVIDER_DISPLAY_NAMES[provider],
        });
      for (const account of matching)
        options.push({
          id: account.instanceId,
          provider,
          instanceId: ProviderInstanceId.make(account.instanceId),
          label:
            matching.length > 1
              ? `${PROVIDER_DISPLAY_NAMES[provider]} · ${account.displayName}`
              : PROVIDER_DISPLAY_NAMES[provider],
        });
    }
    return options;
  }, [accounts]);
  const [accountSelection, setAccountSelection] = useState("");
  const account =
    accountOptions.find((option) => option.id === accountSelection) ?? accountOptions[0]!;

  const [draft, setDraft] = useState<ServerDraft>(createEmptyDraft());
  const [draftBase, setDraftBase] = useState<ServerDraft>(draft);
  const [editingServerName, setEditingServerName] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [isAdvancedOpen, setIsAdvancedOpen] = useState(false);
  const [editorEpoch, setEditorEpoch] = useState(0);
  const [detail, setDetail] = useState<{
    name: string;
    kind: "scope" | "inherited";
    tab: McpDetailTab;
  } | null>(null);
  const [adding, setAdding] = useState<McpAddTab | null>(null);
  // The inherited server an Add dialog overrides, if any.
  const [overriding, setOverriding] = useState<string | null>(null);
  const [removingServer, setRemovingServer] = useState<string | null>(null);
  const [movingToProject, setMovingToProject] = useState<string | null>(null);
  const [moveTarget, setMoveTarget] = useState<string>("");
  const [actionError, setActionError] = useState<string | null>(null);
  const [savedContext, setSavedContext] = useState<string | null>(null);
  const [isApplying, setIsApplying] = useState(false);
  // The last Apply (every server) or Reconnect (one server), so the detail panel can
  // show which conversations did not pick it up and retry them.
  const [sessionOutcomes, setSessionOutcomes] = useState<{
    readonly action: "apply" | "reconnect";
    readonly serverName?: string;
    readonly sessions: ReadonlyArray<McpSessionReloadOutcome>;
  } | null>(null);
  useEffect(() => setSessionOutcomes(null), [selectedProjectId]);
  const [isSavingConfig, setIsSavingConfig] = useState(false);
  const dirty = JSON.stringify(draft) !== JSON.stringify(draftBase);

  const resetEditor = () => {
    setEditorEpoch((epoch) => epoch + 1);
    setEditingServerName(null);
    const empty = createEmptyDraft();
    setDraft(empty);
    setDraftBase(empty);
    setFormError(null);
    setIsAdvancedOpen(false);
  };
  /** A new, unsaved server from the catalog: the form compares against an empty draft. */
  const loadCatalogDraft = (next: ServerDraft) => {
    setEditorEpoch((epoch) => epoch + 1);
    setEditingServerName(null);
    setOverriding(null);
    setDraft(next);
    setDraftBase(createEmptyDraft());
    setFormError(null);
    setIsAdvancedOpen(false);
  };
  const loadEditor = (name: string | null, server: McpProjectServersConfig[string] | null) => {
    setEditorEpoch((epoch) => epoch + 1);
    setEditingServerName(name);
    const next = server ? draftFromServer(name ?? "", server) : createEmptyDraft();
    setDraft(next);
    setDraftBase(name ? next : createEmptyDraft());
    setFormError(null);
    setIsAdvancedOpen(server ? hasAdvancedFields(server) : false);
  };
  const {
    requestChange,
    confirmDiscard,
    dialog: draftGuardDialog,
  } = useMcpDraftGuard(dirty, isSavingConfig, resetEditor);
  const latest = useRef({ draft, editingServerName, scope, selectedProjectId });
  useEffect(() => {
    latest.current = { draft, editingServerName, scope, selectedProjectId };
  });

  // A different settings scope is a different page: close panels and drafts.
  useEffect(() => {
    setDetail(null);
    setAdding(null);
    setSavedContext(null);
    setActionError(null);
    resetEditor();
  }, [selectedProjectId]);

  const commonConfigQuery = useQuery(mcpCommonConfigQueryOptions());
  const projectConfigQuery = useQuery(
    mcpProjectConfigQueryOptions({ projectId: selectedProjectId, enabled: !!selectedProject }),
  );
  const effectiveConfigQuery = useQuery(
    mcpEffectiveConfigQueryOptions({ projectId: selectedProjectId, enabled: !!selectedProject }),
  );
  const hubStatusQuery = useQuery(mcpHubStatusQueryOptions({ projectId: selectedProjectId }));
  const connection = useWsConnectionState();
  const threads = useThreadSummaries();
  const observationContext = JSON.stringify([account.id, selectedProjectId]);
  const [conversationSelection, setConversationSelection] = useState<{
    context: string;
    threadId?: ThreadId;
  }>({ context: "" });
  const selectedThreadId =
    conversationSelection.context === observationContext
      ? conversationSelection.threadId
      : undefined;
  const serverStatusesQuery = useQuery(
    mcpServerStatusesQueryOptions({
      provider: account.provider,
      instanceId: account.instanceId,
      projectId: selectedProjectId,
      ...(selectedThreadId ? { threadId: selectedThreadId } : {}),
      enabled: !!selectedProject && Boolean(effectiveConfigQuery.data),
    }),
  );
  const claudeProviderStatusQuery = useQuery(
    mcpProviderStatusQueryOptions({
      provider: account.provider,
      instanceId: account.instanceId,
      projectId: selectedProjectId,
      enabled:
        account.provider === "claudeAgent" &&
        serverStatusesQuery.data?.source === "configurationCheck",
    }),
  );
  const observation = serverStatusesQuery.data;
  const providerStatus =
    account.provider === "claudeAgent" && observation?.source === "configurationCheck"
      ? claudeProviderStatusQuery.data
      : observation && selectedProjectId
        ? {
            provider: account.provider,
            projectId: selectedProjectId,
            support: observation.support,
            available: observation.support === "supported",
            authStatus: "unknown" as const,
            ...(observation.supportMessage ? { supportMessage: observation.supportMessage } : {}),
          }
        : undefined;
  const observedAccount: McpObservedAccount | undefined = selectedProject
    ? {
        provider: account.provider,
        instanceId: account.instanceId,
        label: account.label,
        data: observation,
      }
    : undefined;

  useMcpStatusUpdates();
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

  const activeConfig = scope === "common" ? commonConfigQuery.data : projectConfigQuery.data;
  const activeConfigQuery = scope === "common" ? commonConfigQuery : projectConfigQuery;
  const activeServers = activeConfig?.servers ?? EMPTY_SERVERS;
  const commonServers = commonConfigQuery.data?.servers ?? EMPTY_SERVERS;
  const orderedServers = useMemo(
    () => (Object.entries(activeServers) as ServerEntry[]).toSorted(byName),
    [activeServers],
  );
  const inheritedServers = useMemo(
    () =>
      scope === "project"
        ? (Object.entries(commonServers) as ServerEntry[])
            .filter(
              ([name]) =>
                !Object.keys(activeServers).some(
                  (own) => mcpServerNameKey(own) === mcpServerNameKey(name),
                ),
            )
            .toSorted(byName)
        : [],
    [scope, commonServers, activeServers],
  );
  const disabledCommon = projectConfigQuery.data?.disabledCommonServers ?? [];
  const isUsedInProject = (name: string) =>
    !disabledCommon.some((entry) => mcpServerNameKey(entry) === mcpServerNameKey(name));
  const hubByName = useMemo(() => {
    const map = new Map<string, McpHubServerStatus[]>();
    for (const entry of hubStatusQuery.data?.servers ?? []) {
      map.set(entry.name, [...(map.get(entry.name) ?? []), entry]);
    }
    return map;
  }, [hubStatusQuery.data]);
  const observedByName = useMemo(
    () =>
      new Map(
        (observation?.statuses ?? [])
          .filter((status) => !status.ownership || status.ownership === "managed")
          .map((status) => [status.name, status]),
      ),
    [observation],
  );
  const statusFor = (name: string, server: McpProjectServersConfig[string]) => {
    const status = summarizeMcpServerStatus(server, [
      ...hubStatusSources(hubByName.get(name) ?? EMPTY_HUB),
      observedStatusSource(account.label, observedByName.get(name)),
    ]);
    // Failure reasons can echo configured secrets; rows show them redacted.
    return status.detail
      ? {
          ...status,
          detail: createMcpDiagnosticsSanitizer({ [name]: server }).text(status.detail),
        }
      : status;
  };
  const effectiveJson =
    selectedProject && effectiveConfigQuery.data
      ? formatMcpServersAsJson(effectiveConfigQuery.data.servers)
      : "";

  const writeLayer = async (
    target: { scope: "common" } | { scope: "project"; projectId: ProjectId },
    nextServers: McpProjectServersConfig,
    expectedVersion: string | undefined,
    disabledCommonServers?: ReadonlyArray<string>,
  ): Promise<McpCommonConfigResult | McpProjectConfigResult> => {
    if (target.scope === "common") {
      const result = await ensureNativeApi().mcp.replaceCommonConfig({
        expectedVersion,
        servers: nextServers,
      });
      queryClient.setQueryData(mcpQueryKeys.commonConfig(), result);
      return result;
    }
    const result = await ensureNativeApi().mcp.replaceProjectConfig({
      projectId: target.projectId,
      expectedVersion,
      servers: nextServers,
      ...(disabledCommonServers ? { disabledCommonServers: [...disabledCommonServers] } : {}),
    });
    queryClient.setQueryData(mcpQueryKeys.projectConfig(target.projectId), result);
    return result;
  };

  const persistScopeServers = async (
    nextServers: McpProjectServersConfig,
    expectedVersion = activeConfig?.version,
  ): Promise<McpCommonConfigResult | McpProjectConfigResult> => {
    setActionError(null);
    setIsSavingConfig(true);
    try {
      const result = await writeLayer(
        selectedProject ? { scope: "project", projectId: selectedProject.id } : { scope: "common" },
        nextServers,
        expectedVersion,
      );
      setSavedContext(`${scope}:${selectedProjectId}`);
      await invalidateMcpConfigQueries(queryClient);
      return result;
    } finally {
      setIsSavingConfig(false);
    }
  };

  /** Saves one changed entry and moves an open form onto the new version. */
  const updateServer = async (name: string, next: McpProjectServersConfig[string]) => {
    const nextServers = toWritableProjectServers(activeServers);
    if (!nextServers[name]) throw new Error("This server is no longer saved.");
    nextServers[name] = next;
    const result = await persistScopeServers(normalizeMcpServersRecord(nextServers));
    const saved = result.servers[name];
    if (saved && latest.current.editingServerName === name) {
      setDraft((current) => rebaseDraft(current, name, saved));
      setDraftBase((current) => rebaseDraft(current, name, saved));
    }
  };

  const reportAction = (promise: Promise<unknown>, fallback: string) => {
    void promise.catch((error) => setActionError(readErrorMessage(error, fallback)));
  };

  const openDetail = (name: string, kind: "scope" | "inherited", tab: McpDetailTab) =>
    requestChange(() => {
      const server = (kind === "scope" ? activeServers : commonServers)[name];
      if (!server) return;
      loadEditor(kind === "scope" ? name : null, kind === "scope" ? server : null);
      setAdding(null);
      setDetail({ name, kind, tab });
    });
  // A link from chat (`server` search param) opens that server's panel once the
  // configuration has loaded, once per link.
  const openedFocus = useRef<string | null>(null);
  useEffect(() => {
    const target = props.focusServer;
    if (!target) {
      openedFocus.current = null;
      return;
    }
    if (openedFocus.current === target || !activeConfig) return;
    if (scope === "project" && !commonConfigQuery.data) return;
    openedFocus.current = target;
    const key = mcpServerNameKey(target);
    const own = Object.keys(activeServers).find((name) => mcpServerNameKey(name) === key);
    const inherited =
      scope === "project"
        ? Object.keys(commonServers).find((name) => mcpServerNameKey(name) === key)
        : undefined;
    if (own) openDetail(own, "scope", "overview");
    else if (inherited) openDetail(inherited, "inherited", "overview");
    // openDetail reads the latest servers; the link opens once per target.
  }, [props.focusServer, activeConfig, commonConfigQuery.data, scope]);
  const closeSurfaces = () =>
    requestChange(() => {
      setDetail(null);
      setAdding(null);
      resetEditor();
    });
  const beginAdd = (
    tab: McpAddTab = "form",
    prefill?: readonly [string, McpProjectServersConfig[string]],
  ) =>
    requestChange(() => {
      resetEditor();
      if (prefill) {
        // An override starts from the inherited entry, keeping its name.
        const next = draftFromServer(prefill[0], prefill[1]);
        setDraft(next);
        setIsAdvancedOpen(hasAdvancedFields(prefill[1]));
      }
      setOverriding(prefill?.[0] ?? null);
      setDetail(null);
      setAdding(tab);
    });

  const saveDraft = () => {
    try {
      const editing = editingServerName;
      if (editing !== null && !Object.hasOwn(activeServers, editing))
        throw new Error(
          "This server was removed from saved configuration. Choose Create from this draft to add it again.",
        );
      const submittedDraft = draft;
      const submittedScope = `${scope}:${selectedProjectId}`;
      const { name, server } = decodeDraftServer(draft);
      const nextServers = toWritableProjectServers(activeServers);
      const collision = Object.keys(nextServers).find(
        (other) => other !== editing && mcpServerNameKey(other) === mcpServerNameKey(name),
      );
      if (collision)
        throw new Error(
          `Server '${collision}' already uses this name. Names are case-insensitive.`,
        );
      if (
        editing === null &&
        !nextServers[name] &&
        Object.keys(nextServers).length >= MAX_SERVER_COUNT
      )
        throw new Error(`You can save at most ${MAX_SERVER_COUNT} MCP servers per scope.`);
      if (editing && editing !== name) delete nextServers[editing];
      nextServers[name] = server;
      const normalized = validateMcpLayerWrite(activeServers, nextServers, {
        inheritedNames: scope === "project" ? Object.keys(commonServers) : [],
      });
      if (!normalized[name]) throw new Error("The MCP server configuration is invalid.");
      setFormError(null);
      void persistScopeServers(normalized)
        .then((result) => {
          if (`${latest.current.scope}:${latest.current.selectedProjectId}` !== submittedScope)
            return;
          const saved = result.servers[name] ?? server;
          if (editing === null) {
            // Added: close the dialog and show the new server's panel.
            loadEditor(name, saved);
            setAdding(null);
            setDetail({ name, kind: "scope", tab: "overview" });
            return;
          }
          const next = draftFromServer(name, saved);
          // Inputs stay editable during I/O; a completed save never erases newer typing.
          setDraftBase(next);
          setEditingServerName(name);
          if (latest.current.draft === submittedDraft) setDraft(next);
          else setDraft((current) => rebaseDraft(current, name, saved));
          setDetail((current) => (current ? { ...current, name } : current));
        })
        .catch((error) => setFormError(readErrorMessage(error, "Failed to save MCP server.")));
    } catch (error) {
      setFormError(readErrorMessage(error, "Failed to save MCP server."));
    }
  };

  const removeServer = (name: string) => {
    const nextServers = toWritableProjectServers(activeServers);
    delete nextServers[name];
    reportAction(
      persistScopeServers(normalizeMcpServersRecord(nextServers)).then(() => {
        if (latest.current.editingServerName === name) {
          setDetail(null);
          resetEditor();
        }
      }),
      "Failed to remove MCP server.",
    );
  };

  const duplicateServer = (name: string) => {
    const server = activeServers[name];
    if (!server) return;
    reportAction(
      (async () => {
        if (Object.keys(activeServers).length >= MAX_SERVER_COUNT)
          throw new Error(`You can save at most ${MAX_SERVER_COUNT} MCP servers per scope.`);
        const copy = copyName(name, [...Object.keys(activeServers), ...Object.keys(commonServers)]);
        const nextServers = { ...toWritableProjectServers(activeServers), [copy]: server };
        await persistScopeServers(validateMcpLayerWrite(activeServers, nextServers));
      })(),
      `Could not duplicate ${name}.`,
    );
  };

  /** Writes the entry to the other layer first, then removes it here. Not atomic. */
  const moveServer = (
    name: string,
    target: { scope: "common" } | { scope: "project"; projectId: ProjectId },
  ) => {
    const server = activeServers[name];
    if (!server) return;
    reportAction(
      (async () => {
        setIsSavingConfig(true);
        try {
          const base =
            target.scope === "common"
              ? await ensureNativeApi().mcp.getCommonConfig({})
              : await ensureNativeApi().mcp.getProjectConfig({ projectId: target.projectId });
          const targetLabel =
            target.scope === "common"
              ? "Common scope"
              : (props.projects?.find((project) => project.id === target.projectId)?.name ??
                "That project");
          if (
            Object.keys(base.servers).some(
              (other) => mcpServerNameKey(other) === mcpServerNameKey(name),
            )
          )
            throw new Error(`${targetLabel} already has a server named '${name}'.`);
          const added = validateMcpLayerWrite(base.servers, { ...base.servers, [name]: server });
          await writeLayer(target, added, base.version);
          const remaining = toWritableProjectServers(activeServers);
          delete remaining[name];
          try {
            await writeLayer(
              selectedProject
                ? { scope: "project", projectId: selectedProject.id }
                : { scope: "common" },
              normalizeMcpServersRecord(remaining),
              activeConfig?.version,
            );
          } catch (cause) {
            throw new Error(
              `Copied '${name}' to ${targetLabel.toLowerCase()}, but could not remove it here: ${readErrorMessage(cause, "unknown error")}`,
            );
          }
          if (latest.current.editingServerName === name) {
            setDetail(null);
            resetEditor();
          }
          setSavedContext(`${scope}:${selectedProjectId}`);
          toastManager.add({
            type: "success",
            title: `Moved ${name} to ${targetLabel.toLowerCase()}`,
          });
        } finally {
          setIsSavingConfig(false);
          await invalidateMcpConfigQueries(queryClient);
        }
      })(),
      `Could not move ${name}.`,
    );
  };

  const reconnectServer = (name: string) => {
    const hubEntries = hubByName.get(name) ?? EMPTY_HUB;
    if (hubEntries.some((entry) => entry.state === "failed" || entry.state === "retrying")) {
      reportAction(
        ensureNativeApi()
          .mcp.reconnectHubServer({
            serverName: name,
            ...(selectedProjectId ? { projectId: selectedProjectId } : {}),
          })
          .then(() =>
            queryClient.invalidateQueries({ queryKey: mcpQueryKeys.hubStatus(selectedProjectId) }),
          ),
        `Could not reconnect ${name}.`,
      );
      return;
    }
    if (!selectedProjectId) return;
    reportAction(
      reconnectMcpServer(queryClient, {
        provider: account.provider,
        instanceId: account.instanceId,
        projectId: selectedProjectId,
        serverName: name,
      }).then((result) =>
        setSessionOutcomes({
          action: "reconnect",
          serverName: name,
          sessions: result.sessions ?? [],
        }),
      ),
      "Reconnect failed.",
    );
  };
  const canReconnect = (name: string) =>
    (hubByName.get(name) ?? EMPTY_HUB).some(
      (entry) => entry.state === "failed" || entry.state === "retrying",
    ) ||
    (!!selectedProjectId &&
      ["failed", "needs-auth", "login-required", "unknown"].includes(
        observedByName.get(name)?.state ?? "",
      ));

  const exportServer = (name: string, server: McpProjectServersConfig[string]) => {
    copyToClipboard(formatMcpServersAsJson({ [name]: server }), undefined);
    toastManager.add({ type: "success", title: `Copied ${name} as JSON` });
  };

  const setUsedInProject = (name: string, used: boolean) => {
    if (!selectedProjectId) return;
    const disabled = new Set(
      disabledCommon.filter((entry) => mcpServerNameKey(entry) !== mcpServerNameKey(name)),
    );
    if (!used) disabled.add(name);
    setIsSavingConfig(true);
    reportAction(
      writeLayer(
        { scope: "project", projectId: selectedProjectId },
        activeServers,
        projectConfigQuery.data?.version,
        [...disabled],
      )
        .then(() => {
          setSavedContext(`${scope}:${selectedProjectId}`);
          return invalidateMcpConfigQueries(queryClient);
        })
        .finally(() => setIsSavingConfig(false)),
      "Could not update inherited server.",
    );
  };

  const applyToLiveSessions = () => {
    setActionError(null);
    setIsApplying(true);
    void ensureNativeApi()
      .mcp.applyToLiveSessions({
        scope,
        ...(selectedProjectId ? { projectId: selectedProjectId } : {}),
      })
      .then(async (result) => {
        setSavedContext(null);
        setSessionOutcomes({ action: "apply", sessions: result.sessions ?? [] });
        const notice = describeMcpApplyProblems(result);
        if (notice) setActionError(notice);
        await queryClient.invalidateQueries({ queryKey: mcpQueryKeys.all });
      })
      .catch((error) =>
        setActionError(
          readErrorMessage(error, "Failed to apply MCP configuration to live sessions."),
        ),
      )
      .finally(() => setIsApplying(false));
  };

  const rowActions = (name: string, server: McpProjectServersConfig[string]) => {
    const actions: Array<McpRowAction | "separator"> = [
      { label: "Edit", run: () => openDetail(name, "scope", "configuration") },
      { label: "Duplicate", run: () => duplicateServer(name) },
    ];
    if (scope === "project")
      actions.push({ label: "Move to common", run: () => moveServer(name, { scope: "common" }) });
    else if (props.projects?.length)
      actions.push({
        label: "Move to project…",
        run: () => {
          setMoveTarget(props.projects?.[0]?.id ?? "");
          setMovingToProject(name);
        },
      });
    if (canReconnect(name)) actions.push({ label: "Reconnect", run: () => reconnectServer(name) });
    actions.push({ label: "Export JSON", run: () => exportServer(name, server) });
    actions.push("separator", {
      label: "Remove",
      destructive: true,
      run: () => {
        if (!isSavingConfig) setRemovingServer(name);
      },
    });
    return actions;
  };

  const savedDetailServer = detail
    ? (detail.kind === "scope" ? activeServers : commonServers)[detail.name]
    : undefined;
  // A server removed elsewhere keeps its panel open on the last saved entry, so the
  // draft survives until the user creates it again or closes the panel.
  const lastDetailServer = useRef<McpProjectServersConfig[string] | undefined>(undefined);
  useEffect(() => {
    lastDetailServer.current = detail ? (savedDetailServer ?? lastDetailServer.current) : undefined;
  });
  const editedServerMissing =
    detail?.kind === "scope" && editingServerName !== null && !savedDetailServer;
  const detailServer =
    savedDetailServer ?? (editedServerMissing ? lastDetailServer.current : undefined);
  const createFromDraft = () => {
    setEditingServerName(null);
    setFormError(null);
    setOverriding(null);
    setDetail(null);
    setAdding("form");
  };
  const editor = (
    <McpServerEditor
      key={`${selectedProjectId}:${editingServerName}:${editorEpoch}`}
      projectId={selectedProjectId}
      instanceId={account.instanceId}
      editingServerName={editingServerName}
      draft={draft}
      onDraftChange={(patch) => {
        setDraft((current) => ({ ...current, ...patch }));
        setFormError(null);
      }}
      onAdvancedDraftChange={(patch) => setDraft((current) => ({ ...current, ...patch }))}
      formError={formError}
      isAdvancedOpen={isAdvancedOpen}
      onAdvancedOpenChange={setIsAdvancedOpen}
      isSavingConfig={isSavingConfig}
      saveBlocked={editedServerMissing}
      onCancel={
        editingServerName
          ? dirty
            ? () => {
                setDraft(draftBase);
                setFormError(null);
              }
            : undefined
          : closeSurfaces
      }
      saveDraft={saveDraft}
    />
  );
  const issues = activeConfig?.issues ?? [];
  const loading = activeConfigQuery.isPending && !activeConfig;

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
        description={`Remove this server from ${scopeLabel}? Running sessions keep their current configuration until it is applied.`}
        confirmLabel="Remove server"
        onCancel={() => setRemovingServer(null)}
        onConfirm={() => {
          const name = removingServer;
          setRemovingServer(null);
          if (!name) return;
          if (editingServerName === name && dirty) requestChange(() => removeServer(name));
          else removeServer(name);
        }}
      />
      <Dialog
        open={movingToProject !== null}
        onOpenChange={(open) => !open && setMovingToProject(null)}
      >
        <DialogPopup className="max-w-md p-5">
          <DialogTitle>Move “{movingToProject}” to a project</DialogTitle>
          <DialogDescription>
            The server is added to the project, then removed from common scope.
          </DialogDescription>
          <select
            aria-label="Target project"
            className="my-3 block w-full rounded border border-border bg-background p-2 text-sm"
            value={moveTarget}
            onChange={(event) => setMoveTarget(event.target.value)}
          >
            {props.projects?.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="outline" onClick={() => setMovingToProject(null)}>
              Cancel
            </Button>
            <Button
              size="sm"
              disabled={!moveTarget}
              onClick={() => {
                const name = movingToProject;
                const project = props.projects?.find((entry) => entry.id === moveTarget);
                setMovingToProject(null);
                if (name && project) moveServer(name, { scope: "project", projectId: project.id });
              }}
            >
              Move
            </Button>
          </div>
        </DialogPopup>
      </Dialog>

      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 className="text-sm font-medium text-foreground">MCP servers</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            {selectedProject
              ? `Servers for ${selectedProject.name}. A project server overrides a common server with the same name.`
              : props.hasProjects
                ? "Common servers apply to every project. Choose a project in the settings scope to edit its own servers."
                : "Common servers apply to every project."}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button size="xs" variant="outline" disabled={isApplying} onClick={applyToLiveSessions}>
            Apply to live sessions
          </Button>
          <Button size="xs" disabled={isSavingConfig || loading} onClick={() => beginAdd("form")}>
            Add server
          </Button>
        </div>
      </div>

      <div className="space-y-4">
        {issues.map((issue, index) => (
          <p key={index} role="status" className="text-xs text-warning-foreground">
            {issue.message}
          </p>
        ))}
        {savedContext === `${scope}:${selectedProjectId}` ? (
          <p role="status" className="rounded border p-3 text-xs">
            Saved. Codex and Claude sessions pick up MCP changes on their next message, restarting
            if needed; other agents in their next session.{" "}
            <Button size="xs" variant="outline" disabled={isApplying} onClick={applyToLiveSessions}>
              Apply to all live sessions
            </Button>
          </p>
        ) : null}
        {selectedProject ? (
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <label className="flex items-center gap-2">
              <span className="text-muted-foreground">Codex and Claude status from</span>
              <select
                aria-label="Status account"
                value={account.id}
                className="rounded border border-border bg-background p-1"
                onChange={(event) => setAccountSelection(event.target.value)}
              >
                {accountOptions.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            <McpProviderStatusBadge
              provider={account.provider}
              status={providerStatus}
              source={observation?.source}
              isLoading={
                (effectiveConfigQuery.fetchStatus === "fetching" ||
                  serverStatusesQuery.fetchStatus === "fetching" ||
                  claudeProviderStatusQuery.fetchStatus === "fetching") &&
                !providerStatus
              }
              isApplying={isApplying}
            />
            {providerStatus?.supportMessage ? (
              <span className="text-muted-foreground">{providerStatus.supportMessage}</span>
            ) : null}
          </div>
        ) : null}
        {activeConfigQuery.error ? (
          <p className="text-xs text-destructive">
            {readErrorMessage(
              activeConfigQuery.error,
              `Failed to load MCP ${scope} configuration.`,
            )}
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
        {actionError ? (
          <p role="alert" className="text-xs text-destructive">
            {actionError}
          </p>
        ) : null}

        <McpHubNotice servers={effectiveConfigQuery.data?.servers ?? activeConfig?.servers} />

        <section
          aria-label={scope === "project" ? "Project servers" : "Common servers"}
          className="space-y-2"
        >
          <p className="text-sm font-medium text-foreground">
            {scope === "project" ? "Project servers" : "Common servers"} ({orderedServers.length}/
            {MAX_SERVER_COUNT})
          </p>
          {loading ? (
            <p className="rounded-lg border border-dashed border-border px-3 py-4 text-xs text-muted-foreground">
              Loading MCP servers for this scope...
            </p>
          ) : orderedServers.length ? (
            <ul className="divide-y divide-border rounded-lg border border-border bg-background">
              {orderedServers.map(([name, server]) => (
                <McpServerListRow
                  key={name}
                  name={name}
                  server={server}
                  status={statusFor(name, server)}
                  busy={isSavingConfig}
                  onOpen={() => openDetail(name, "scope", "overview")}
                  switchLabel={`Enable MCP server ${name}`}
                  checked={server.enabled !== false}
                  onCheckedChange={(checked) =>
                    reportAction(
                      updateServer(name, { ...server, enabled: checked }),
                      "Failed to update MCP server.",
                    )
                  }
                  actions={rowActions(name, server)}
                />
              ))}
            </ul>
          ) : (
            <p className="rounded-lg border border-dashed border-border px-3 py-4 text-xs text-muted-foreground">
              No MCP servers configured for this scope.
            </p>
          )}
        </section>

        {inheritedServers.length ? (
          <section aria-label="Inherited from common" className="space-y-2">
            <p className="text-sm font-medium text-foreground">Inherited from common</p>
            <ul className="divide-y divide-border rounded-lg border border-border bg-background">
              {inheritedServers.map(([name, server]) => (
                <McpServerListRow
                  key={name}
                  name={name}
                  server={server}
                  status={
                    isUsedInProject(name)
                      ? statusFor(name, server)
                      : { tone: "outline", label: "Not used here" }
                  }
                  busy={isSavingConfig}
                  onOpen={() => openDetail(name, "inherited", "overview")}
                  switchLabel={`Use ${name} in this project`}
                  checked={isUsedInProject(name)}
                  onCheckedChange={(used) => setUsedInProject(name, used)}
                  actions={[
                    { label: "Override", run: () => beginAdd("form", [name, server]) },
                    { label: "Export JSON", run: () => exportServer(name, server) },
                  ]}
                />
              ))}
            </ul>
          </section>
        ) : null}

        {selectedProject ? (
          <details className="rounded-lg border border-border p-3 text-xs">
            <summary className="cursor-pointer text-sm font-medium text-foreground">
              Provider-managed servers
            </summary>
            <div className="mt-3 space-y-3">
              <p className="text-muted-foreground">
                Servers {account.label} configures itself, F5's built-in servers, and servers
                waiting to be removed. They are read-only here.
              </p>
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
                    {observation?.sessions?.map((session) => (
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
                {observation?.source === "conversation"
                  ? `Observed in ${threads.find((thread) => thread.id === observation.threadId)?.title ?? observation.threadId} at ${observation.observedAt ? new Date(observation.observedAt).toLocaleTimeString() : "unknown time"}`
                  : "Configuration check"}
              </p>
              {observation?.source === "conversation" &&
              observation.appliedVersion !==
                (effectiveConfigQuery.data?.effectiveVersion ?? observation.desiredVersion) ? (
                <p>Saved changes are pending in this conversation.</p>
              ) : null}
              {account.provider === "claudeAgent" &&
              observation?.source === "configurationCheck" ? (
                <p>
                  Live status appears while a Claude session for this account runs in this project.
                </p>
              ) : null}
              {observation?.complete === false ? (
                <p>Partial observation. Missing servers have unknown status.</p>
              ) : null}
              <McpObservedGroup
                group="managed"
                servers={effectiveConfigQuery.data?.servers ?? activeServers}
                removedNames={
                  observation?.statuses
                    .filter(
                      (status) =>
                        status.ownership === "managed" &&
                        !Object.keys(effectiveConfigQuery.data?.servers ?? {}).some(
                          (name) => mcpServerNameKey(name) === mcpServerNameKey(status.name),
                        ),
                    )
                    .map((status) => status.name) ?? []
                }
                observation={observation}
                projectId={selectedProjectId}
                provider={account.provider}
                instanceId={account.instanceId}
              />
              {(["built-in", "external"] as const).map((group) => (
                <McpObservedGroup
                  key={group}
                  group={group}
                  servers={effectiveConfigQuery.data?.servers ?? activeServers}
                  observation={observation}
                  projectId={selectedProjectId}
                  provider={account.provider}
                  instanceId={account.instanceId}
                />
              ))}
              {!observation?.statuses.some(
                (status) => status.ownership && status.ownership !== "managed",
              ) ? (
                <p className="text-muted-foreground">No provider-managed servers observed.</p>
              ) : null}
            </div>
          </details>
        ) : null}

        {selectedProject ? (
          <McpExport
            effectiveJson={effectiveJson}
            selectedProject={selectedProject}
            isCopied={isCopied}
            onCopy={() => copyToClipboard(effectiveJson, undefined)}
            handleExportJson={() => {
              if (!effectiveJson) return;
              const filenameBase =
                selectedProject.name
                  .toLowerCase()
                  .replace(/[^a-z0-9]+/g, "-")
                  .replace(/^-+|-+$/g, "") || "mcp-config";
              const url = URL.createObjectURL(
                new Blob([effectiveJson], { type: "application/json;charset=utf-8" }),
              );
              const anchor = document.createElement("a");
              anchor.href = url;
              anchor.download = `${filenameBase}.json`;
              anchor.click();
              window.setTimeout(() => URL.revokeObjectURL(url), 0);
            }}
          />
        ) : null}
      </div>

      {detail && detailServer ? (
        <McpServerDetailSheet
          open
          onOpenChange={(open) => {
            if (!open) closeSurfaces();
          }}
          tab={detail.tab}
          onTabChange={(tab) => setDetail((current) => (current ? { ...current, tab } : current))}
          name={detail.name}
          server={detailServer}
          kind={detail.kind}
          scopeLabel={detail.kind === "inherited" ? "inherited from common scope" : scopeLabel}
          projectId={selectedProjectId}
          account={observedAccount}
          hubEntries={hubByName.get(detail.name) ?? EMPTY_HUB}
          busy={isSavingConfig}
          isApplying={isApplying}
          onApply={applyToLiveSessions}
          outcomeAction={sessionOutcomes?.action ?? "apply"}
          outcomes={
            sessionOutcomes?.action === "reconnect" && sessionOutcomes.serverName !== detail.name
              ? undefined
              : sessionOutcomes?.sessions.filter(
                  (outcome) =>
                    outcome.instanceId === account.instanceId &&
                    (sessionOutcomes.action === "reconnect" ||
                      serverStatusesQuery.data?.sessions?.some(
                        (session) => session.threadId === outcome.threadId,
                      )),
                )
          }
          onReconnected={(sessions) =>
            setSessionOutcomes({ action: "reconnect", serverName: detail.name, sessions })
          }
          onServerChange={(next) => updateServer(detail.name, next)}
          onOverride={
            detail.kind === "inherited"
              ? () => beginAdd("form", [detail.name, detailServer])
              : undefined
          }
          editor={
            editedServerMissing ? (
              <div className="space-y-4">
                <div role="status" className="space-y-2 rounded border p-3 text-xs">
                  <p>
                    This server was removed from saved configuration. Your draft is kept, and saving
                    is blocked until you create it again.
                  </p>
                  <Button
                    size="xs"
                    variant="outline"
                    onClick={createFromDraft}
                    disabled={isSavingConfig}
                  >
                    Create from this draft
                  </Button>
                </div>
                {editor}
              </div>
            ) : (
              editor
            )
          }
        />
      ) : null}
      <McpAddServerDialog
        open={adding !== null}
        onOpenChange={(open) => {
          if (!open) closeSurfaces();
        }}
        tab={adding ?? "form"}
        onTabChange={(tab) => setAdding(tab)}
        title={overriding ? `Override ${overriding}` : "Add MCP server"}
        scopeLabel={scopeLabel}
        form={editor}
        onCatalogChoose={(choice) => {
          const name = uniqueMcpServerName(choice.name, activeServers);
          loadCatalogDraft(draftFromCatalog({ ...choice, name }));
          setAdding("form");
          const asks = [
            ...(choice.secretKeys.length > 0
              ? [`Store a secret for ${choice.secretKeys.join(", ")}.`]
              : []),
            ...(choice.needsInput.length > 0 ? [`Fill in ${choice.needsInput.join(", ")}.`] : []),
          ];
          toastManager.add({
            type: "info",
            title: `Review ${name} before saving`,
            description: [...asks, "Nothing runs until you save."].join(" "),
          });
        }}
        importProps={{
          scope,
          projectId: selectedProjectId,
          instanceId: account.instanceId,
          servers: activeServers,
          version: activeConfig?.version,
          onImport: persistScopeServers,
          onRefreshBase: () => invalidateMcpConfigQueries(queryClient),
          onImported: () => {
            setAdding(null);
            resetEditor();
          },
        }}
      />
    </section>
  );
}
