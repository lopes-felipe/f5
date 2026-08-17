import {
  AGENTS_WS_CHANNELS,
  AGENTS_WS_METHODS,
  USAGE_WS_METHODS,
  type AgentsSnapshot,
  type GitActionProgressEvent,
  type GitStatusInvalidatedPayload,
  type McpStatusUpdatedPayload,
  type NextTurnQueueSnapshot,
  type NextTurnQueueSummary,
  ORCHESTRATION_WS_CHANNELS,
  ORCHESTRATION_WS_METHODS,
  OrchestrationRetryWorkflowResult,
  type PreviewAutomationRequest,
  type DiscoveredLocalServerList,
  type PreviewEvent,
  type ContextMenuItem,
  type NativeApi,
  PR_HUB_WS_CHANNELS,
  PR_HUB_WS_METHODS,
  type PrHubAdvisorySnapshot,
  type PrHubSnapshot,
  type ServerProviderAdvisoriesUpdatedPayload,
  ServerConfigUpdatedPayload,
  type StorageCleanupProgressPayload,
  type StorageInvalidatedPayload,
  WS_CHANNELS,
  WS_METHODS,
  type WsWelcomePayload,
} from "@t3tools/contracts";
import { CODEX_MCP_OAUTH_LOGIN_REQUEST_TIMEOUT_MS } from "@t3tools/shared/codexOAuthTiming";
import { Schema } from "effect";

import { showContextMenuFallback } from "./contextMenuFallback";
import { WsTransport } from "./wsTransport";

let instance: { api: NativeApi; transport: WsTransport } | null = null;
const welcomeListeners = new Set<(payload: WsWelcomePayload) => void>();
const serverConfigUpdatedListeners = new Set<(payload: ServerConfigUpdatedPayload) => void>();
const providerAdvisoriesUpdatedListeners = new Set<
  (payload: ServerProviderAdvisoriesUpdatedPayload) => void
>();
const gitActionProgressListeners = new Set<(payload: GitActionProgressEvent) => void>();
const gitStatusInvalidatedListeners = new Set<(payload: GitStatusInvalidatedPayload) => void>();
const previewEventListeners = new Set<(payload: PreviewEvent) => void>();
const previewLocalServersUpdatedListeners = new Set<(payload: DiscoveredLocalServerList) => void>();
const previewAutomationRequestListeners = new Set<(payload: PreviewAutomationRequest) => void>();
const mcpStatusUpdatedListeners = new Set<(payload: McpStatusUpdatedPayload) => void>();
const storageInvalidatedListeners = new Set<(payload: StorageInvalidatedPayload) => void>();
const storageCleanupProgressListeners = new Set<(payload: StorageCleanupProgressPayload) => void>();
const nextTurnQueueUpdatedListeners = new Set<(payload: NextTurnQueueSnapshot) => void>();
const nextTurnQueueSummaryUpdatedListeners = new Set<(payload: NextTurnQueueSummary) => void>();
const prHubSnapshotUpdatedListeners = new Set<(payload: PrHubSnapshot) => void>();
const prHubAdvisoriesUpdatedListeners = new Set<(payload: PrHubAdvisorySnapshot) => void>();
const agentsSnapshotUpdatedListeners = new Set<(payload: AgentsSnapshot) => void>();

/**
 * Subscribe to the server welcome message. If a welcome was already received
 * before this call, the listener fires synchronously with the cached payload.
 * This avoids the race between WebSocket connect and React effect registration.
 */
export function onServerWelcome(listener: (payload: WsWelcomePayload) => void): () => void {
  welcomeListeners.add(listener);

  const latestWelcome = instance?.transport.getLatestPush(WS_CHANNELS.serverWelcome)?.data ?? null;
  if (latestWelcome) {
    try {
      listener(latestWelcome);
    } catch {
      // Swallow listener errors
    }
  }

  return () => {
    welcomeListeners.delete(listener);
  };
}

/**
 * Subscribe to server config update events. Replays the latest update for
 * late subscribers to avoid missing config validation feedback.
 */
export function onServerConfigUpdated(
  listener: (payload: ServerConfigUpdatedPayload) => void,
): () => void {
  serverConfigUpdatedListeners.add(listener);

  const latestConfig =
    instance?.transport.getLatestPush(WS_CHANNELS.serverConfigUpdated)?.data ?? null;
  if (latestConfig) {
    try {
      listener(latestConfig);
    } catch {
      // Swallow listener errors
    }
  }

  return () => {
    serverConfigUpdatedListeners.delete(listener);
  };
}

export function onProviderAdvisoriesUpdated(
  listener: (payload: ServerProviderAdvisoriesUpdatedPayload) => void,
): () => void {
  providerAdvisoriesUpdatedListeners.add(listener);

  const latestAdvisories =
    instance?.transport.getLatestPush(WS_CHANNELS.providerAdvisoriesUpdated)?.data ?? null;
  if (latestAdvisories) {
    try {
      listener(latestAdvisories);
    } catch {
      // Swallow listener errors
    }
  }

  return () => {
    providerAdvisoriesUpdatedListeners.delete(listener);
  };
}

export function onPrHubUpdated(listener: (payload: PrHubSnapshot) => void): () => void {
  prHubSnapshotUpdatedListeners.add(listener);

  const latestSnapshot =
    instance?.transport.getLatestPush(PR_HUB_WS_CHANNELS.snapshotUpdated)?.data ?? null;
  if (latestSnapshot) {
    try {
      listener(latestSnapshot);
    } catch {
      // Swallow listener errors
    }
  }

  return () => {
    prHubSnapshotUpdatedListeners.delete(listener);
  };
}

export function onPrHubAdvisoriesUpdated(
  listener: (payload: PrHubAdvisorySnapshot) => void,
): () => void {
  prHubAdvisoriesUpdatedListeners.add(listener);

  const latestSnapshot =
    instance?.transport.getLatestPush(PR_HUB_WS_CHANNELS.advisoriesUpdated)?.data ?? null;
  if (latestSnapshot) {
    try {
      listener(latestSnapshot);
    } catch {
      // Swallow listener errors
    }
  }

  return () => {
    prHubAdvisoriesUpdatedListeners.delete(listener);
  };
}

export function createWsNativeApi(): NativeApi {
  if (instance) return instance.api;

  const transport = new WsTransport();

  transport.subscribe(WS_CHANNELS.serverWelcome, (message) => {
    const payload = message.data;
    for (const listener of welcomeListeners) {
      try {
        listener(payload);
      } catch {
        // Swallow listener errors
      }
    }
  });
  transport.subscribe(AGENTS_WS_CHANNELS.snapshotUpdated, (message) => {
    const payload = message.data;
    for (const listener of agentsSnapshotUpdatedListeners) {
      try {
        listener(payload);
      } catch {
        // Swallow listener errors
      }
    }
  });
  transport.subscribe(WS_CHANNELS.serverConfigUpdated, (message) => {
    const payload = message.data;
    for (const listener of serverConfigUpdatedListeners) {
      try {
        listener(payload);
      } catch {
        // Swallow listener errors
      }
    }
  });
  transport.subscribe(WS_CHANNELS.providerAdvisoriesUpdated, (message) => {
    const payload = message.data;
    for (const listener of providerAdvisoriesUpdatedListeners) {
      try {
        listener(payload);
      } catch {
        // Swallow listener errors
      }
    }
  });
  transport.subscribe(WS_CHANNELS.gitActionProgress, (message) => {
    const payload = message.data;
    for (const listener of gitActionProgressListeners) {
      try {
        listener(payload);
      } catch {
        // Swallow listener errors
      }
    }
  });
  transport.subscribe(WS_CHANNELS.gitStatusInvalidated, (message) => {
    const payload = message.data;
    for (const listener of gitStatusInvalidatedListeners) {
      try {
        listener(payload);
      } catch {
        // Swallow listener errors
      }
    }
  });
  transport.subscribe(WS_CHANNELS.previewEvent, (message) => {
    const payload = message.data;
    for (const listener of previewEventListeners) {
      try {
        listener(payload);
      } catch {
        // Swallow listener errors
      }
    }
  });
  transport.subscribe(WS_CHANNELS.previewLocalServersUpdated, (message) => {
    const payload = message.data;
    for (const listener of previewLocalServersUpdatedListeners) {
      try {
        listener(payload);
      } catch {
        // Swallow listener errors
      }
    }
  });
  transport.subscribe(WS_CHANNELS.previewAutomationRequest, (message) => {
    const payload = message.data;
    for (const listener of previewAutomationRequestListeners) {
      try {
        listener(payload);
      } catch {
        // Swallow listener errors
      }
    }
  });
  transport.subscribe(WS_CHANNELS.mcpStatusUpdated, (message) => {
    const payload = message.data;
    for (const listener of mcpStatusUpdatedListeners) {
      try {
        listener(payload);
      } catch {
        // Swallow listener errors
      }
    }
  });
  transport.subscribe(WS_CHANNELS.storageInvalidated, (message) => {
    const payload = message.data;
    for (const listener of storageInvalidatedListeners) {
      try {
        listener(payload);
      } catch {
        // Swallow listener errors
      }
    }
  });
  transport.subscribe(WS_CHANNELS.storageCleanupProgress, (message) => {
    const payload = message.data;
    for (const listener of storageCleanupProgressListeners) {
      try {
        listener(payload);
      } catch {
        // Swallow listener errors
      }
    }
  });
  transport.subscribe(WS_CHANNELS.nextTurnQueueUpdated, (message) => {
    const payload = message.data;
    for (const listener of nextTurnQueueUpdatedListeners) {
      try {
        listener(payload);
      } catch {
        // Swallow listener errors
      }
    }
  });
  transport.subscribe(WS_CHANNELS.nextTurnQueueSummaryUpdated, (message) => {
    const payload = message.data;
    for (const listener of nextTurnQueueSummaryUpdatedListeners) {
      try {
        listener(payload);
      } catch {
        // Swallow listener errors
      }
    }
  });
  transport.subscribe(PR_HUB_WS_CHANNELS.snapshotUpdated, (message) => {
    const payload = message.data;
    for (const listener of prHubSnapshotUpdatedListeners) {
      try {
        listener(payload);
      } catch {
        // Swallow listener errors
      }
    }
  });
  transport.subscribe(PR_HUB_WS_CHANNELS.advisoriesUpdated, (message) => {
    const payload = message.data;
    for (const listener of prHubAdvisoriesUpdatedListeners) {
      try {
        listener(payload);
      } catch {
        // Swallow listener errors
      }
    }
  });

  const api: NativeApi = {
    dialogs: {
      pickFolder: async () => {
        if (!window.desktopBridge) return null;
        return window.desktopBridge.pickFolder();
      },
      confirm: async (message) => {
        if (window.desktopBridge) {
          return window.desktopBridge.confirm(message);
        }
        return window.confirm(message);
      },
    },
    terminal: {
      open: (input) => transport.request(WS_METHODS.terminalOpen, input),
      write: (input) => transport.request(WS_METHODS.terminalWrite, input),
      resize: (input) => transport.request(WS_METHODS.terminalResize, input),
      clear: (input) => transport.request(WS_METHODS.terminalClear, input),
      restart: (input) => transport.request(WS_METHODS.terminalRestart, input),
      close: (input) => transport.request(WS_METHODS.terminalClose, input),
      onEvent: (callback) =>
        transport.subscribe(WS_CHANNELS.terminalEvent, (message) => callback(message.data)),
    },
    preview: {
      open: (input) => transport.request(WS_METHODS.previewOpen, input),
      navigate: (input) => transport.request(WS_METHODS.previewNavigate, input),
      reportStatus: (input) => transport.request(WS_METHODS.previewReportStatus, input),
      reportRecordingMetrics: (input) =>
        transport.request(WS_METHODS.previewReportRecordingMetrics, input),
      refresh: (input) => transport.request(WS_METHODS.previewRefresh, input),
      close: (input) => transport.request(WS_METHODS.previewClose, input),
      list: (input) => transport.request(WS_METHODS.previewList, input),
      listLocalServers: (input = {}) =>
        transport.request(WS_METHODS.previewListLocalServers, input),
      automation: {
        respond: (response) => transport.request(WS_METHODS.previewAutomationRespond, response),
        reportOwner: (owner) => transport.request(WS_METHODS.previewAutomationReportOwner, owner),
        clearOwner: (input) => transport.request(WS_METHODS.previewAutomationClearOwner, input),
        onRequest: (callback) => {
          previewAutomationRequestListeners.add(callback);
          return () => {
            previewAutomationRequestListeners.delete(callback);
          };
        },
      },
      onEvent: (callback) => {
        previewEventListeners.add(callback);
        return () => {
          previewEventListeners.delete(callback);
        };
      },
      onLocalServersUpdated: (callback) => {
        previewLocalServersUpdatedListeners.add(callback);
        return () => {
          previewLocalServersUpdatedListeners.delete(callback);
        };
      },
    },
    projects: {
      getCheckedInConfig: (input) =>
        transport.request(WS_METHODS.projectsGetCheckedInConfig, input),
      authorizeEntry: (input) => transport.request(WS_METHODS.projectsAuthorizeEntry, input),
      listEntries: (input) => transport.request(WS_METHODS.projectsListEntries, input),
      searchEntries: (input) => transport.request(WS_METHODS.projectsSearchEntries, input),
      searchContents: (input) => transport.request(WS_METHODS.projectsSearchContents, input),
      cancelContentSearch: (input) =>
        transport.request(WS_METHODS.projectsCancelContentSearch, input),
      writeFile: (input) => transport.request(WS_METHODS.projectsWriteFile, input),
      readFile: (input) => transport.request(WS_METHODS.projectsReadFile, input),
    },
    filesystem: {
      browse: (input) => transport.request(WS_METHODS.filesystemBrowse, input),
    },
    shell: {
      openInEditor: (cwd, editor) =>
        transport.request(WS_METHODS.shellOpenInEditor, { cwd, editor }),
      revealInFileManager: (input) => transport.request(WS_METHODS.shellRevealInFileManager, input),
      openExternal: async (url) => {
        if (window.desktopBridge) {
          const opened = await window.desktopBridge.openExternal(url);
          if (!opened) {
            throw new Error("Unable to open link.");
          }
          return;
        }

        // Some mobile browsers can return null here even when the tab opens.
        // Avoid false negatives and let the browser handle popup policy.
        window.open(url, "_blank", "noopener,noreferrer");
      },
    },
    git: {
      pull: (input) => transport.request(WS_METHODS.gitPull, input),
      status: (input) => transport.request(WS_METHODS.gitStatus, input),
      runStackedAction: (input) =>
        transport.request(WS_METHODS.gitRunStackedAction, input, { timeoutMs: null }),
      listBranches: (input) => transport.request(WS_METHODS.gitListBranches, input),
      createWorktree: (input) => transport.request(WS_METHODS.gitCreateWorktree, input),
      removeWorktree: (input) => transport.request(WS_METHODS.gitRemoveWorktree, input),
      createBranch: (input) => transport.request(WS_METHODS.gitCreateBranch, input),
      checkout: (input) => transport.request(WS_METHODS.gitCheckout, input),
      init: (input) => transport.request(WS_METHODS.gitInit, input),
      resolvePullRequest: (input) => transport.request(WS_METHODS.gitResolvePullRequest, input),
      preparePullRequestThread: (input) =>
        transport.request(WS_METHODS.gitPreparePullRequestThread, input),
      onActionProgress: (callback) => {
        gitActionProgressListeners.add(callback);
        return () => {
          gitActionProgressListeners.delete(callback);
        };
      },
      onStatusInvalidated: (callback) => {
        gitStatusInvalidatedListeners.add(callback);
        return () => {
          gitStatusInvalidatedListeners.delete(callback);
        };
      },
    },
    review: {
      previewDiff: (input) => transport.request(WS_METHODS.reviewPreviewDiff, input),
    },
    contextMenu: {
      show: async <T extends string>(
        items: readonly ContextMenuItem<T>[],
        position?: { x: number; y: number },
      ): Promise<T | null> => {
        if (window.desktopBridge) {
          return window.desktopBridge.showContextMenu(items, position) as Promise<T | null>;
        }
        return showContextMenuFallback(items, position);
      },
    },
    server: {
      getConfig: () => transport.request(WS_METHODS.serverGetConfig),
      updateSettings: (input) => transport.request(WS_METHODS.serverUpdateSettings, input),
      refreshProviders: () => transport.request(WS_METHODS.serverRefreshProviders),
      validateHarnesses: (input) => transport.request(WS_METHODS.serverValidateHarnesses, input),
      upsertKeybinding: (input) => transport.request(WS_METHODS.serverUpsertKeybinding, input),
      addKeybinding: (input) => transport.request(WS_METHODS.serverAddKeybinding, input),
      updateKeybinding: (input) => transport.request(WS_METHODS.serverUpdateKeybinding, input),
      removeKeybinding: (input) => transport.request(WS_METHODS.serverRemoveKeybinding, input),
      resetKeybindings: (input = {}) => transport.request(WS_METHODS.serverResetKeybindings, input),
    },
    mcp: {
      getCommonConfig: (input) => transport.request(WS_METHODS.mcpGetCommonConfig, input),
      getProjectConfig: (input) => transport.request(WS_METHODS.mcpGetProjectConfig, input),
      replaceCommonConfig: (input) => transport.request(WS_METHODS.mcpReplaceCommonConfig, input),
      replaceProjectConfig: (input) => transport.request(WS_METHODS.mcpReplaceProjectConfig, input),
      getEffectiveConfig: (input) => transport.request(WS_METHODS.mcpGetEffectiveConfig, input),
      getProviderStatus: (input) => transport.request(WS_METHODS.mcpGetProviderStatus, input),
      getServerStatuses: (input) => transport.request(WS_METHODS.mcpGetServerStatuses, input),
      startLogin: (input) =>
        transport.request(
          WS_METHODS.mcpStartLogin,
          input,
          input.provider === "codex"
            ? { timeoutMs: CODEX_MCP_OAUTH_LOGIN_REQUEST_TIMEOUT_MS }
            : undefined,
        ),
      getLoginStatus: (input) => transport.request(WS_METHODS.mcpGetLoginStatus, input),
      getCodexStatus: (input) => transport.request(WS_METHODS.mcpGetCodexStatus, input),
      reloadProject: (input) => transport.request(WS_METHODS.mcpReloadProject, input),
      applyToLiveSessions: (input) => transport.request(WS_METHODS.mcpApplyToLiveSessions, input),
      startOAuthLogin: (input) =>
        transport.request(WS_METHODS.mcpStartOAuthLogin, input, {
          timeoutMs: CODEX_MCP_OAUTH_LOGIN_REQUEST_TIMEOUT_MS,
        }),
      getOAuthStatus: (input) => transport.request(WS_METHODS.mcpGetOAuthStatus, input),
      onStatusUpdated: (callback) => {
        mcpStatusUpdatedListeners.add(callback);
        return () => {
          mcpStatusUpdatedListeners.delete(callback);
        };
      },
    },
    storage: {
      getUsage: (input = {}) => transport.request(WS_METHODS.storageGetUsage, input),
      cleanup: (input) => transport.request(WS_METHODS.storageCleanup, input, { timeoutMs: null }),
      cancelCleanup: (input) => transport.request(WS_METHODS.storageCancelCleanup, input),
      onInvalidated: (callback) => {
        storageInvalidatedListeners.add(callback);
        return () => {
          storageInvalidatedListeners.delete(callback);
        };
      },
      onCleanupProgress: (callback) => {
        storageCleanupProgressListeners.add(callback);
        return () => {
          storageCleanupProgressListeners.delete(callback);
        };
      },
    },
    nextTurnQueue: {
      list: (input) => transport.request(WS_METHODS.nextTurnQueueList, input),
      submit: (input) => transport.request(WS_METHODS.nextTurnQueueSubmit, input),
      summary: () => transport.request(WS_METHODS.nextTurnQueueSummary),
      update: (input) => transport.request(WS_METHODS.nextTurnQueueUpdate, input),
      cancel: (input) => transport.request(WS_METHODS.nextTurnQueueCancel, input),
      reorder: (input) => transport.request(WS_METHODS.nextTurnQueueReorder, input),
      retry: (input) => transport.request(WS_METHODS.nextTurnQueueRetry, input),
      promote: (input) => transport.request(WS_METHODS.nextTurnQueuePromote, input),
      setPaused: (input) => transport.request(WS_METHODS.nextTurnQueueSetPaused, input),
      duplicate: (input) => transport.request(WS_METHODS.nextTurnQueueDuplicate, input),
      refreshGate: (input) => transport.request(WS_METHODS.nextTurnQueueRefreshGate, input),
      clear: (input) => transport.request(WS_METHODS.nextTurnQueueClear, input),
      restore: (input) => transport.request(WS_METHODS.nextTurnQueueRestore, input),
      recheckDelivery: (input) => transport.request(WS_METHODS.nextTurnQueueRecheckDelivery, input),
      retryDelivery: (input) => transport.request(WS_METHODS.nextTurnQueueRetryDelivery, input),
      discardDelivery: (input) => transport.request(WS_METHODS.nextTurnQueueDiscardDelivery, input),
      onUpdated: (callback) => {
        nextTurnQueueUpdatedListeners.add(callback);
        return () => {
          nextTurnQueueUpdatedListeners.delete(callback);
        };
      },
      onSummaryUpdated: (callback) => {
        nextTurnQueueSummaryUpdatedListeners.add(callback);
        return () => {
          nextTurnQueueSummaryUpdatedListeners.delete(callback);
        };
      },
    },
    globalSearch: {
      query: (input) => transport.request(WS_METHODS.globalSearchQuery, input),
    },
    agents: {
      getSnapshot: () => transport.request(AGENTS_WS_METHODS.getSnapshot),
      onSnapshotUpdated: (callback) => {
        agentsSnapshotUpdatedListeners.add(callback);
        const latest = transport.getLatestPush(AGENTS_WS_CHANNELS.snapshotUpdated)?.data ?? null;
        if (latest) callback(latest);
        return () => {
          agentsSnapshotUpdatedListeners.delete(callback);
        };
      },
    },
    usage: {
      getSummary: (input) => transport.request(USAGE_WS_METHODS.getSummary, input),
    },
    workflowPlatform: {
      listTemplates: () => transport.request(WS_METHODS.workflowPlatformListTemplates),
      createRun: (input) => transport.request(WS_METHODS.workflowPlatformCreateRun, input),
      inspectRun: (input) => transport.request(WS_METHODS.workflowPlatformInspectRun, input),
    },
    prHub: {
      getSnapshot: () => transport.request(PR_HUB_WS_METHODS.getSnapshot),
      refresh: (input) => transport.request(PR_HUB_WS_METHODS.refresh, input),
      approve: (input) => transport.request(PR_HUB_WS_METHODS.approve, input),
      requestChanges: (input) => transport.request(PR_HUB_WS_METHODS.requestChanges, input),
      comment: (input) => transport.request(PR_HUB_WS_METHODS.comment, input),
      merge: (input) => transport.request(PR_HUB_WS_METHODS.merge, input),
      markReady: (input) => transport.request(PR_HUB_WS_METHODS.markReady, input),
      reRequestReview: (input) => transport.request(PR_HUB_WS_METHODS.reRequestReview, input),
      snooze: (input) => transport.request(PR_HUB_WS_METHODS.snooze, input),
      unsnooze: (input) => transport.request(PR_HUB_WS_METHODS.unsnooze, input),
      ignore: (input) => transport.request(PR_HUB_WS_METHODS.ignore, input),
      markSeen: (input) => transport.request(PR_HUB_WS_METHODS.markSeen, input),
      markNotified: (input) => transport.request(PR_HUB_WS_METHODS.markNotified, input),
      analyzeAdvisories: (input = {}) =>
        transport.request(PR_HUB_WS_METHODS.analyzeAdvisories, input, { timeoutMs: null }),
      getAdvisories: (input = {}) => transport.request(PR_HUB_WS_METHODS.getAdvisories, input),
      listLocalCheckoutCandidates: (input) =>
        transport.request(PR_HUB_WS_METHODS.listLocalCheckoutCandidates, input),
      getDetail: (input) => transport.request(PR_HUB_WS_METHODS.getDetail, input),
      getTimeline: (input) => transport.request(PR_HUB_WS_METHODS.getTimeline, input),
      getFiles: (input) => transport.request(PR_HUB_WS_METHODS.getFiles, input),
      updateComment: (input) => transport.request(PR_HUB_WS_METHODS.updateComment, input),
      setReaction: (input) => transport.request(PR_HUB_WS_METHODS.setReaction, input),
      changeReviewers: (input) => transport.request(PR_HUB_WS_METHODS.changeReviewers, input),
      updateBranch: (input) => transport.request(PR_HUB_WS_METHODS.updateBranch, input),
      clearData: (input = {}) => transport.request(PR_HUB_WS_METHODS.clearData, input),
      onSnapshotUpdated: (callback) => onPrHubUpdated(callback),
      onAdvisoriesUpdated: (callback) => onPrHubAdvisoriesUpdated(callback),
    },
    orchestration: {
      getSnapshot: () => transport.request(ORCHESTRATION_WS_METHODS.getSnapshot),
      getStartupSnapshot: (input) =>
        transport.request(ORCHESTRATION_WS_METHODS.getStartupSnapshot, input),
      getThreadTailDetails: (input) =>
        transport.request(ORCHESTRATION_WS_METHODS.getThreadTailDetails, input),
      getThreadHistoryPage: (input) =>
        transport.request(ORCHESTRATION_WS_METHODS.getThreadHistoryPage, input),
      getThreadDetails: (input) =>
        transport.request(ORCHESTRATION_WS_METHODS.getThreadDetails, input),
      dispatchCommand: (command) =>
        transport.request(ORCHESTRATION_WS_METHODS.dispatchCommand, { command }),
      getTurnDiff: (input) => transport.request(ORCHESTRATION_WS_METHODS.getTurnDiff, input),
      getFullThreadDiff: (input) =>
        transport.request(ORCHESTRATION_WS_METHODS.getFullThreadDiff, input),
      getThreadCommandExecutions: (input) =>
        transport.request(ORCHESTRATION_WS_METHODS.getThreadCommandExecutions, input),
      getThreadCommandExecution: (input) =>
        transport.request(ORCHESTRATION_WS_METHODS.getThreadCommandExecution, input),
      getThreadFileChanges: (input) =>
        transport.request(ORCHESTRATION_WS_METHODS.getThreadFileChanges, input),
      getThreadFileChange: (input) =>
        transport.request(ORCHESTRATION_WS_METHODS.getThreadFileChange, input),
      createWorkflow: (input) => transport.request(ORCHESTRATION_WS_METHODS.createWorkflow, input),
      archiveWorkflow: (input) =>
        transport.request(ORCHESTRATION_WS_METHODS.archiveWorkflow, input),
      unarchiveWorkflow: (input) =>
        transport.request(ORCHESTRATION_WS_METHODS.unarchiveWorkflow, input),
      createCodeReviewWorkflow: (input) =>
        transport.request(ORCHESTRATION_WS_METHODS.createCodeReviewWorkflow, input),
      createInvestigationWorkflow: (input) =>
        transport.request(ORCHESTRATION_WS_METHODS.createInvestigationWorkflow, input),
      archiveCodeReviewWorkflow: (input) =>
        transport.request(ORCHESTRATION_WS_METHODS.archiveCodeReviewWorkflow, input),
      archiveInvestigationWorkflow: (input) =>
        transport.request(ORCHESTRATION_WS_METHODS.archiveInvestigationWorkflow, input),
      unarchiveCodeReviewWorkflow: (input) =>
        transport.request(ORCHESTRATION_WS_METHODS.unarchiveCodeReviewWorkflow, input),
      unarchiveInvestigationWorkflow: (input) =>
        transport.request(ORCHESTRATION_WS_METHODS.unarchiveInvestigationWorkflow, input),
      deleteWorkflow: (input) => transport.request(ORCHESTRATION_WS_METHODS.deleteWorkflow, input),
      deleteCodeReviewWorkflow: (input) =>
        transport.request(ORCHESTRATION_WS_METHODS.deleteCodeReviewWorkflow, input),
      deleteInvestigationWorkflow: (input) =>
        transport.request(ORCHESTRATION_WS_METHODS.deleteInvestigationWorkflow, input),
      retryWorkflow: async (input) =>
        Schema.decodeUnknownSync(OrchestrationRetryWorkflowResult)(
          await transport.request(ORCHESTRATION_WS_METHODS.retryWorkflow, input),
        ),
      retryCodeReviewWorkflow: (input) =>
        transport.request(ORCHESTRATION_WS_METHODS.retryCodeReviewWorkflow, input),
      retryInvestigationWorkflow: (input) =>
        transport.request(ORCHESTRATION_WS_METHODS.retryInvestigationWorkflow, input),
      startImplementation: (input) =>
        transport.request(ORCHESTRATION_WS_METHODS.startImplementation, input),
      onDomainEvent: (callback) =>
        transport.subscribe(ORCHESTRATION_WS_CHANNELS.domainEvent, (message) =>
          callback(message.data),
        ),
    },
  };

  instance = { api, transport };
  return api;
}

export function onMcpStatusUpdated(
  listener: (payload: McpStatusUpdatedPayload) => void,
): () => void {
  mcpStatusUpdatedListeners.add(listener);

  const latestPush = instance?.transport.getLatestPush(WS_CHANNELS.mcpStatusUpdated)?.data ?? null;
  if (latestPush) {
    try {
      listener(latestPush);
    } catch {
      // Swallow listener errors
    }
  }

  return () => {
    mcpStatusUpdatedListeners.delete(listener);
  };
}

export function onStorageInvalidated(
  listener: (payload: StorageInvalidatedPayload) => void,
): () => void {
  storageInvalidatedListeners.add(listener);

  const latestPush =
    instance?.transport.getLatestPush(WS_CHANNELS.storageInvalidated)?.data ?? null;
  if (latestPush) {
    try {
      listener(latestPush);
    } catch {
      // Swallow listener errors
    }
  }

  return () => {
    storageInvalidatedListeners.delete(listener);
  };
}
