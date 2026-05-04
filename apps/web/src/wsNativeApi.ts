import {
  type GitActionProgressEvent,
  type GitStatusInvalidatedPayload,
  type McpStatusUpdatedPayload,
  ORCHESTRATION_WS_CHANNELS,
  ORCHESTRATION_WS_METHODS,
  type ContextMenuItem,
  type NativeApi,
  ServerConfigUpdatedPayload,
  WS_CHANNELS,
  WS_METHODS,
  type WsWelcomePayload,
} from "@t3tools/contracts";

import { showContextMenuFallback } from "./contextMenuFallback";
import { WsTransport } from "./wsTransport";

let instance: { api: NativeApi; transport: WsTransport } | null = null;
const welcomeListeners = new Set<(payload: WsWelcomePayload) => void>();
const serverConfigUpdatedListeners = new Set<(payload: ServerConfigUpdatedPayload) => void>();
const gitActionProgressListeners = new Set<(payload: GitActionProgressEvent) => void>();
const gitStatusInvalidatedListeners = new Set<(payload: GitStatusInvalidatedPayload) => void>();
const mcpStatusUpdatedListeners = new Set<(payload: McpStatusUpdatedPayload) => void>();

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
    projects: {
      searchEntries: (input) => transport.request(WS_METHODS.projectsSearchEntries, input),
      writeFile: (input) => transport.request(WS_METHODS.projectsWriteFile, input),
      readFile: (input) => transport.request(WS_METHODS.projectsReadFile, input),
    },
    filesystem: {
      browse: (input) => transport.request(WS_METHODS.filesystemBrowse, input),
    },
    shell: {
      openInEditor: (cwd, editor) =>
        transport.request(WS_METHODS.shellOpenInEditor, { cwd, editor }),
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
      validateHarnesses: (input) => transport.request(WS_METHODS.serverValidateHarnesses, input),
      upsertKeybinding: (input) => transport.request(WS_METHODS.serverUpsertKeybinding, input),
    },
    mcp: {
      getCommonConfig: (input) => transport.request(WS_METHODS.mcpGetCommonConfig, input),
      getProjectConfig: (input) => transport.request(WS_METHODS.mcpGetProjectConfig, input),
      replaceCommonConfig: (input) => transport.request(WS_METHODS.mcpReplaceCommonConfig, input),
      replaceProjectConfig: (input) => transport.request(WS_METHODS.mcpReplaceProjectConfig, input),
      getEffectiveConfig: (input) => transport.request(WS_METHODS.mcpGetEffectiveConfig, input),
      getProviderStatus: (input) => transport.request(WS_METHODS.mcpGetProviderStatus, input),
      getServerStatuses: (input) => transport.request(WS_METHODS.mcpGetServerStatuses, input),
      startLogin: (input) => transport.request(WS_METHODS.mcpStartLogin, input),
      getLoginStatus: (input) => transport.request(WS_METHODS.mcpGetLoginStatus, input),
      getCodexStatus: (input) => transport.request(WS_METHODS.mcpGetCodexStatus, input),
      reloadProject: (input) => transport.request(WS_METHODS.mcpReloadProject, input),
      applyToLiveSessions: (input) => transport.request(WS_METHODS.mcpApplyToLiveSessions, input),
      startOAuthLogin: (input) => transport.request(WS_METHODS.mcpStartOAuthLogin, input),
      getOAuthStatus: (input) => transport.request(WS_METHODS.mcpGetOAuthStatus, input),
      onStatusUpdated: (callback) => {
        mcpStatusUpdatedListeners.add(callback);
        return () => {
          mcpStatusUpdatedListeners.delete(callback);
        };
      },
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
      replayEvents: (fromSequenceExclusive) =>
        transport.request(ORCHESTRATION_WS_METHODS.replayEvents, { fromSequenceExclusive }),
      createWorkflow: (input) => transport.request(ORCHESTRATION_WS_METHODS.createWorkflow, input),
      archiveWorkflow: (input) =>
        transport.request(ORCHESTRATION_WS_METHODS.archiveWorkflow, input),
      unarchiveWorkflow: (input) =>
        transport.request(ORCHESTRATION_WS_METHODS.unarchiveWorkflow, input),
      createCodeReviewWorkflow: (input) =>
        transport.request(ORCHESTRATION_WS_METHODS.createCodeReviewWorkflow, input),
      archiveCodeReviewWorkflow: (input) =>
        transport.request(ORCHESTRATION_WS_METHODS.archiveCodeReviewWorkflow, input),
      unarchiveCodeReviewWorkflow: (input) =>
        transport.request(ORCHESTRATION_WS_METHODS.unarchiveCodeReviewWorkflow, input),
      deleteWorkflow: (input) => transport.request(ORCHESTRATION_WS_METHODS.deleteWorkflow, input),
      deleteCodeReviewWorkflow: (input) =>
        transport.request(ORCHESTRATION_WS_METHODS.deleteCodeReviewWorkflow, input),
      retryWorkflow: (input) => transport.request(ORCHESTRATION_WS_METHODS.retryWorkflow, input),
      retryCodeReviewWorkflow: (input) =>
        transport.request(ORCHESTRATION_WS_METHODS.retryCodeReviewWorkflow, input),
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
