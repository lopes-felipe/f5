import { stringifyWithinBytes } from "@t3tools/shared/boundedJson";
import { resolveCodexCommand } from "../codexExecutable.ts";
import { CodexGeneratedImages } from "../codexGeneratedImages.ts";
import { CodexTurnUsage } from "../codexTurnUsage.ts";
import { makeCodexGeneratedImageStore } from "../codexGeneratedImageStore.ts";
import { readMcpAppToolResult } from "@t3tools/shared/mcpApp";
import { snapshotMcpApp } from "../../mcpApps/McpAppSnapshot.ts";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import {
  registerNotificationQueueResources,
  providerNotificationOverflows,
} from "../../observability/Metrics.ts";
import { NotificationAdmission } from "../notificationAdmission.ts";
import { ServerShutdown } from "../../shutdown.ts";
import { observeCodexMcpServers } from "../codexMcpObservation.ts";
import { mcpProviderReads, mcpContextKey } from "../../mcp/McpReadCoordinator.ts";
import {
  assertMcpRuntimeConfig,
  mcpConfigErrorMessage,
  assertMcpServerLimit,
  MCP_RUNTIME_SERVER_LIMIT,
} from "@t3tools/shared/mcpValidation";
import { automationEventSanitizer } from "@t3tools/shared/automationActivitySanitizer";
import { makeAutomationRuntimeEventPreparer } from "../prepareAutomationRuntimeEvent";
import { resolveAgentBrowserPolicy } from "../../mcp/browserAccess";
import { resolveComputerBackendSelection } from "../../computer/computerBackendPolicy";
import { providerRuntimeCapabilities } from "@t3tools/shared/providerRuntimeCapabilities";
import {
  mergeCodexLimitSnapshot,
  type CodexLimitSnapshot,
  type CodexTerminalFailureEvidence,
} from "../codexErrors.ts";
export { normalizeCodexThreadItemType } from "../codexItemPresentation.ts";
/**
 * CodexAdapterLive - Scoped live implementation for the Codex provider adapter.
 *
 * Wraps `CodexAppServerManager` behind the `CodexAdapter` service contract and
 * maps manager failures into the shared `ProviderAdapterError` algebra.
 *
 * @module CodexAdapterLive
 */
import {
  type ProviderEvent,
  type ProviderSession,
  type ProviderRuntimeEvent,
  EventId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type McpServerDefinition,
} from "@t3tools/contracts";
import { resolveCodexFastMode } from "@t3tools/shared/model";
import {
  filterEnabledMcpServers,
  readCodexMcpOAuthCallbackConfig,
  translateMcpForCodex,
} from "@t3tools/shared/mcpTranslation";
import {
  codexServerNamesMatch,
  decodeCodexMcpServerStatus,
} from "../../codex/codexMcpServerStatus.ts";
import {
  restartRequiredMcpReload,
  stableMcpConfigKey,
  summarizeMcpReload,
} from "../mcpReconcile.ts";
import {
  isFatalCodexProcessStderrMessage,
  isIgnorableCodexProcessStderrMessage,
} from "@t3tools/shared/codexStderr";
import { StderrDiagnosticBatch } from "../stderrDiagnosticBatch.ts";
import {
  Cause,
  Effect,
  FileSystem,
  Layer,
  Metric,
  Option,
  Path,
  Queue,
  Schema,
  Semaphore,
  Stream,
} from "effect";

import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import { CodexAdapter, type CodexAdapterShape } from "../Services/CodexAdapter.ts";
import {
  CodexAppServerManager,
  CodexJsonRpcError,
  type CodexAppServerStartSessionInput,
  isSyntheticOneOffThreadId,
} from "../../codexAppServerManager.ts";
import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import type { PreviewMcpSessionConfig } from "../../mcp/PreviewMcpHttpServer.ts";
import { writeProviderEventLog, makeEventNdjsonLogger } from "./EventNdjsonLogger.ts";
import { appendProviderAttachmentRuntimeContext } from "../attachmentRuntimeContext.ts";
import { randomUUID } from "node:crypto";
import { userInfo } from "node:os";
import { resolveCodexHome } from "../../os-jank.ts";
import type { AgentCapabilityState } from "./claudeAgentBrowser.ts";
import {
  CODEX_CHROME_SERVER_NAME,
  codexChromeEligibility,
  codexChromeFingerprint,
  codexChromeMcpServer,
  codexChromeReadyDetail,
  effectiveCodexHome,
  inspectCodexBinary,
} from "../codexChromeIntegration.ts";
import { CodexChromeSession } from "../codexChromeSession.ts";
import { codexChromeInstructions } from "../../computer/codexNativeIntegrations.ts";

import {
  PROVIDER,
  codexServiceTierOptions,
  resolveCodexSelectionOptions,
  type CodexAdapterLiveOptions,
  mergeCodexProviderOptions,
  toMessage,
  toRequestError,
} from "../codex/CodexOptions.ts";
import {
  asObject,
  asString,
  codexReasoningTokensSinceBaseline,
  MAX_MERGED_DELTA_BYTES,
  notificationContextKey,
  mergeableContentDelta,
  type PendingDeltaSlot,
  mergeContentDeltas,
  runtimeEventBase,
  hookTargetItemId,
  observeCodexChrome,
  trackCodexChromeCall,
  withAgentBrowserPreview,
  mapToRuntimeEvents,
} from "../codex/CodexEventTranslator.ts";

export {
  resolveCodexSelectionOptions,
  type CodexAdapterLiveOptions,
  codexReasoningTokensSinceBaseline,
  hookTargetItemId,
  observeCodexChrome,
  trackCodexChromeCall,
  withAgentBrowserPreview,
};

export const makeCodexAdapter = (options?: CodexAdapterLiveOptions) =>
  Effect.gen(function* () {
    const serverConfig = yield* Effect.service(ServerConfig);
    const shutdown = yield* Effect.serviceOption(ServerShutdown);
    const boundInstanceId = options?.instanceId ?? ProviderInstanceId.make(PROVIDER);
    const nativeEventLogger =
      options?.nativeEventLogger ??
      (options?.nativeEventLogPath !== undefined
        ? yield* makeEventNdjsonLogger(options.nativeEventLogPath, {
            stream: "native",
          })
        : undefined);

    const manager = yield* Effect.acquireRelease(
      Effect.gen(function* () {
        if (options?.manager) {
          return options.manager;
        }
        const services = yield* Effect.services<never>();
        return options?.makeManager?.(services) ?? new CodexAppServerManager(services);
      }),
      (manager) =>
        Effect.sync(() => {
          try {
            manager.stopAll();
          } catch {
            // Finalizers should never fail and block shutdown.
          }
        }),
    );
    const inheritsFastMode = (model: string | undefined) =>
      resolveCodexFastMode(
        undefined,
        model ? options?.getEffectiveModelCapabilities?.().get(model) : undefined,
      );
    const computerDecisions = new Map<
      ThreadId,
      Effect.Success<ReturnType<typeof resolveComputerBackendSelection>>
    >();
    const computerSessionFields = (threadId: ThreadId): Partial<ProviderSession> => {
      const decision = computerDecisions.get(threadId);
      const chromeFingerprint = chromeFingerprints.get(threadId);
      return {
        ...(decision
          ? {
              computerConfigurationFingerprint: decision.fingerprint,
              ...(decision.selection ? { computerBackendSelection: decision.selection } : {}),
              computerToolsInstalled: computerMcpSessions.has(threadId),
            }
          : {}),
        ...(chromeFingerprint ? { chromeConfigurationFingerprint: chromeFingerprint } : {}),
      };
    };
    /** Interactive desktop sessions only: a toggle change restarts before the next turn. */
    const chromeFingerprints = new Map<ThreadId, string>();
    /** Codex Chrome per session: Codex's `node_repl` entry, its supervision and its state. */
    const chromeSessions = new Map<
      ThreadId,
      {
        state: { state: AgentCapabilityState; detail?: string };
        serverDefinition?: McpServerDefinition;
        session?: CodexChromeSession;
        /** Set when Chrome bound the broker session itself (no computer catalog). */
        boundGeneration?: string;
      }
    >();
    const disposeChromeSession = (threadId: ThreadId) => {
      const chrome = chromeSessions.get(threadId);
      if (!chrome) return;
      chromeSessions.delete(threadId);
      // Main stops the adopted `node_repl`; it would otherwise outlive the session.
      chrome.session?.dispose();
      if (chrome.boundGeneration)
        options?.computerAutomationBroker?.releaseSession(threadId, chrome.boundGeneration);
    };
    const computerMcpSessions = new Map<ThreadId, PreviewMcpSessionConfig>();
    const previewMcpSessions = new Map<ThreadId, PreviewMcpSessionConfig>();
    const threadMcpSessions = new Map<ThreadId, PreviewMcpSessionConfig>();
    const automationGenerations = new Map<ThreadId, number | undefined>();
    // Sessions pin F5's MCP servers with `-c mcp_servers=...` at launch, so a
    // reload cannot change that set; a different desired set needs a restart.
    const launchedMcpConfigKeys = new Map<ThreadId, string>();
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        for (const session of previewMcpSessions.values()) {
          session.dispose();
        }
        previewMcpSessions.clear();
        for (const threadId of [...chromeSessions.keys()]) disposeChromeSession(threadId);
        chromeFingerprints.clear();
        for (const session of threadMcpSessions.values()) session.dispose();
        threadMcpSessions.clear();
        for (const session of computerMcpSessions.values()) session.dispose();
        computerMcpSessions.clear();
        computerDecisions.clear();
      }),
    );

    const startSession: CodexAdapterShape["startSession"] = (input) => {
      if (input.provider !== undefined && input.provider !== PROVIDER) {
        return Effect.fail(
          new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "startSession",
            issue: `Expected provider '${PROVIDER}' but received '${input.provider}'.`,
          }),
        );
      }

      let computerMcpSession: PreviewMcpSessionConfig | undefined;
      let previewMcpSession: PreviewMcpSessionConfig | undefined;
      let threadMcpSession: PreviewMcpSessionConfig | undefined;
      const disposePreviewMcpSession = () => {
        disposeChromeSession(input.threadId);
        computerMcpSession?.dispose();
        computerMcpSessions.delete(input.threadId);
        computerDecisions.delete(input.threadId);
        threadMcpSession?.dispose();
        threadMcpSessions.delete(input.threadId);
        previewMcpSession?.dispose();
        previewMcpSessions.delete(input.threadId);
      };

      return Effect.gen(function* () {
        const providerOptions = mergeCodexProviderOptions(
          options?.defaultProviderOptions,
          input.providerOptions,
        );
        const baseProviderMcpServers = providerOptions?.mcpServers;
        yield* Effect.try({
          try: () => {
            assertMcpRuntimeConfig(input.providerOptions?.mcpServers, PROVIDER);
            assertMcpRuntimeConfig(providerOptions?.mcpServers, PROVIDER);
            readCodexMcpOAuthCallbackConfig(providerOptions?.mcpServers);
          },
          catch: (cause) =>
            new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startSession",
              issue: mcpConfigErrorMessage(cause),
            }),
        });
        previewMcpSessions.get(input.threadId)?.dispose();
        previewMcpSessions.delete(input.threadId);
        previewMcpSession =
          serverConfig.mode === "desktop" && !isSyntheticOneOffThreadId(input.threadId)
            ? options?.previewMcpHttpServer?.createSessionConfig({
                threadId: input.threadId,
                ...(input.providerInstanceId
                  ? { providerInstanceId: input.providerInstanceId }
                  : {}),
                existingServerNames: new Set(Object.keys(baseProviderMcpServers ?? {})),
              })
            : undefined;
        // Registered before launch so `session/configured` can report the installed server.
        if (previewMcpSession) previewMcpSessions.set(input.threadId, previewMcpSession);
        // Retire the old event producer before disposing its computer provenance.
        if (computerMcpSessions.has(input.threadId) && manager.hasSession(input.threadId))
          manager.stopSession(input.threadId);
        computerMcpSessions.get(input.threadId)?.dispose();
        computerMcpSessions.delete(input.threadId);
        computerDecisions.delete(input.threadId);
        const computerPolicy = yield* resolveAgentBrowserPolicy(input.threadId);
        const computerDecision = yield* resolveComputerBackendSelection({
          provider: "codex",
          enabled: serverConfig.mode === "desktop" && computerPolicy.computerUse,
          fullAccess: input.runtimeMode === "full-access",
          nativeStatus: options?.computerAutomationBroker?.host.status() ?? {
            available: false,
            reason: "no-host",
          },
        });
        computerDecisions.set(input.threadId, computerDecision);
        computerMcpSession =
          serverConfig.mode === "desktop" &&
          !input.workflowExecutionProfile &&
          !isSyntheticOneOffThreadId(input.threadId) &&
          computerPolicy.computerUse &&
          computerDecision.selection?.kind === "native"
            ? options?.previewMcpHttpServer?.createSessionConfig({
                threadId: input.threadId,
                catalog: "computer",
                existingServerNames: new Set([
                  ...Object.keys(baseProviderMcpServers ?? {}),
                  ...(previewMcpSession ? [previewMcpSession.serverName] : []),
                ]),
              })
            : undefined;
        if (computerMcpSession) {
          computerMcpSessions.set(input.threadId, computerMcpSession);
          automationEventSanitizer.register(input.threadId, {
            serverName: computerMcpSession.serverName,
            verified: true,
            kind: "f5-computer",
          });
        }
        // Codex Chrome: Codex starts ChatGPT's `node_repl` and F5 supervises it. Only
        // interactive desktop sessions with the toggle on do any Chrome I/O; workflow and
        // synthetic sessions never do.
        disposeChromeSession(input.threadId);
        chromeFingerprints.delete(input.threadId);
        const chromeBroker = options?.computerAutomationBroker;
        let chromeInstructions: string | undefined;
        const chromeInteractive =
          serverConfig.mode === "desktop" &&
          !input.workflowExecutionProfile &&
          !isSyntheticOneOffThreadId(input.threadId);
        // A session an automation starts gets no Chrome (consent needs a person); its
        // fingerprint says so, and the next person's turn restarts it with Chrome.
        if (chromeInteractive)
          chromeFingerprints.set(
            input.threadId,
            codexChromeFingerprint(computerPolicy.codexChrome && !input.unattended),
          );
        if (computerPolicy.codexChrome && chromeInteractive && chromeBroker) {
          const entry: NonNullable<ReturnType<typeof chromeSessions.get>> = {
            state: { state: "unavailable" },
          };
          chromeSessions.set(input.threadId, entry);
          if (input.unattended)
            entry.state = {
              state: "unavailable",
              detail:
                "Not started for a scheduled run. Chrome control starts with your next message.",
            };
          else if (baseProviderMcpServers?.[CODEX_CHROME_SERVER_NAME])
            entry.state = {
              state: "unavailable",
              detail: `An MCP server named "${CODEX_CHROME_SERVER_NAME}" is configured. Rename it to use Codex Chrome control.`,
            };
          else {
            const userHome = userInfo().homedir;
            const processEnvironment = options?.processEnvironment ?? process.env;
            const codexHomePath = resolveCodexHome({ homePath: providerOptions?.codex?.homePath });
            const binaryPath = yield* Effect.try({
              try: () => resolveCodexCommand(providerOptions?.codex?.binaryPath),
              catch: (cause) =>
                new ProviderAdapterProcessError({
                  provider: PROVIDER,
                  threadId: input.threadId,
                  detail: toMessage(cause, "Bundled Codex is unavailable."),
                  cause,
                }),
            });
            const codex = yield* Effect.promise(() =>
              inspectCodexBinary({
                binaryPath,
                processEnvironment,
                cwd: input.cwd ?? process.cwd(),
                ...(codexHomePath ? { homePath: codexHomePath } : {}),
              }),
            );
            const eligibility = yield* Effect.promise(() =>
              codexChromeEligibility({
                codexHome: effectiveCodexHome(codexHomePath, processEnvironment),
                userHome,
                runtimeMode: input.runtimeMode,
                codex,
              }),
            );
            if (!eligibility.eligible)
              entry.state = { state: "unavailable", detail: eligibility.reason };
            else {
              let generation = chromeBroker.generation(input.threadId);
              if (!computerMcpSession || !generation) {
                generation = randomUUID();
                chromeBroker.bindSession(input.threadId, generation, "codex");
                entry.boundGeneration = generation;
              }
              const threadId = input.threadId;
              // Codex starts `node_repl` with the session and asks nothing per call, so the
              // user consents before the MCP config that starts it is built.
              const allowed = yield* Effect.promise(() =>
                chromeBroker.requestChromeSession(threadId, generation, "codex-chrome"),
              );
              if (!allowed)
                entry.state = {
                  state: "unavailable",
                  detail: "Chrome control wasn't allowed for this session.",
                };
              else {
                const services = yield* Effect.services<never>();
                entry.serverDefinition = codexChromeMcpServer(eligibility, processEnvironment);
                entry.session = new CodexChromeSession({
                  threadId,
                  generation,
                  installation: eligibility.installation,
                  userHome,
                  broker: chromeBroker,
                  codex: {
                    pid: () => manager.codexProcessId(threadId),
                    providerThreadId: () => manager.providerThreadId(threadId),
                    listServer: async () => {
                      const listing = await manager.getMcpServerStatuses(threadId, {
                        deadline: Date.now() + 10_000,
                      });
                      return listing.complete
                        ? listing.entries.find((row) => row.name === CODEX_CHROME_SERVER_NAME)
                        : undefined;
                    },
                    reload: async () => {
                      await manager.reloadMcpConfig(threadId);
                    },
                    callTool: (tool, args, meta) =>
                      manager.callMcpServerTool(
                        threadId,
                        CODEX_CHROME_SERVER_NAME,
                        tool,
                        args,
                        meta,
                      ),
                  },
                  supportsBrowserResume: () => manager.browserResumeAvailable(threadId),
                  waitForMcpIdle: (deadline, check) =>
                    manager.waitForMcpIdle(threadId, deadline, check),
                  policyEnabled: () =>
                    Effect.runPromise(
                      resolveAgentBrowserPolicy(threadId).pipe(
                        Effect.map((policy) => policy.codexChrome),
                        Effect.provide(services),
                      ),
                    ),
                  stateChanged: (state, detail) => {
                    if (chromeSessions.get(threadId) === entry)
                      entry.state = { state, ...(detail ? { detail } : {}) };
                  },
                });
                chromeInstructions = codexChromeInstructions(eligibility.installation);
                // JavaScript source and page output have no safe field-level structure.
                automationEventSanitizer.mask(threadId, CODEX_CHROME_SERVER_NAME);
              }
            }
          }
        }
        const chromeServer = chromeSessions.get(input.threadId)?.serverDefinition;
        threadMcpSessions.get(input.threadId)?.dispose();
        threadMcpSessions.delete(input.threadId);
        threadMcpSession =
          options?.previewMcpHttpServer?.supportsThreadCatalog &&
          !isSyntheticOneOffThreadId(input.threadId)
            ? options.previewMcpHttpServer.createSessionConfig({
                threadId: input.threadId,
                catalog: "thread",
                // Read-only workflow stages may still read the threads their request references.
                threadAccess: input.workflowExecutionProfile ? "read-only" : "full",
                ...(input.providerInstanceId
                  ? { providerInstanceId: input.providerInstanceId }
                  : {}),
                existingServerNames: new Set([
                  ...Object.keys(baseProviderMcpServers ?? {}),
                  ...(previewMcpSession ? [previewMcpSession.serverName] : []),
                  ...(computerMcpSession ? [computerMcpSession.serverName] : []),
                  ...(chromeServer ? [CODEX_CHROME_SERVER_NAME] : []),
                ]),
              })
            : undefined;
        if (threadMcpSession) threadMcpSessions.set(input.threadId, threadMcpSession);
        const providerMcpServers =
          previewMcpSession || computerMcpSession || threadMcpSession || chromeServer
            ? {
                ...baseProviderMcpServers,
                ...(threadMcpSession
                  ? { [threadMcpSession.serverName]: threadMcpSession.serverDefinition }
                  : {}),
                ...(previewMcpSession
                  ? { [previewMcpSession.serverName]: previewMcpSession.serverDefinition }
                  : {}),
                ...(computerMcpSession
                  ? { [computerMcpSession.serverName]: computerMcpSession.serverDefinition }
                  : {}),
                ...(chromeServer ? { [CODEX_CHROME_SERVER_NAME]: chromeServer } : {}),
              }
            : baseProviderMcpServers;
        yield* Effect.try({
          try: () =>
            assertMcpServerLimit(
              filterEnabledMcpServers(providerMcpServers),
              MCP_RUNTIME_SERVER_LIMIT,
            ),
          catch: (cause) =>
            new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startSession",
              issue: mcpConfigErrorMessage(cause),
            }),
        });
        const mcpOAuthCallbackConfig = providerMcpServers
          ? yield* Effect.try({
              try: () => readCodexMcpOAuthCallbackConfig(providerMcpServers),
              catch: (cause) =>
                new ProviderAdapterValidationError({
                  provider: PROVIDER,
                  operation: "startSession",
                  issue: toMessage(cause, "Invalid Codex MCP OAuth callback configuration."),
                  cause,
                }),
            })
          : {};
        const chromeGeneration = chromeBroker?.generation(input.threadId);
        const managerInput: CodexAppServerStartSessionInput = {
          ...(chromeServer && chromeBroker && chromeGeneration
            ? {
                browserResume: () =>
                  chromeBroker.resumeCodexBrowser(input.threadId, chromeGeneration),
              }
            : {}),
          ...(input.mcpEventIdentity ? { mcpEventIdentity: input.mcpEventIdentity } : {}),
          threadId: input.threadId,
          provider: "codex",
          ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
          ...(input.projectTitle !== undefined ? { projectTitle: input.projectTitle } : {}),
          ...(input.threadTitle !== undefined ? { threadTitle: input.threadTitle } : {}),
          ...(input.turnCount !== undefined ? { turnCount: input.turnCount } : {}),
          ...(input.projectMemories !== undefined
            ? { projectMemories: input.projectMemories }
            : {}),
          ...(input.priorWorkSummary !== undefined
            ? { priorWorkSummary: input.priorWorkSummary }
            : {}),
          ...(input.preservedTranscriptBefore !== undefined
            ? { preservedTranscriptBefore: input.preservedTranscriptBefore }
            : {}),
          ...(input.preservedTranscriptAfter !== undefined
            ? { preservedTranscriptAfter: input.preservedTranscriptAfter }
            : {}),
          ...(input.restoredRecentFileRefs !== undefined
            ? { restoredRecentFileRefs: input.restoredRecentFileRefs }
            : {}),
          ...(input.restoredActivePlan !== undefined
            ? { restoredActivePlan: input.restoredActivePlan }
            : {}),
          ...(input.restoredTasks !== undefined ? { restoredTasks: input.restoredTasks } : {}),
          ...(input.sessionNotes !== undefined ? { sessionNotes: input.sessionNotes } : {}),
          ...(input.resumeCursor !== undefined ? { resumeCursor: input.resumeCursor } : {}),
          ...(providerOptions !== undefined ? { providerOptions } : {}),
          ...(options?.processEnvironment !== undefined
            ? { processEnvironment: options.processEnvironment }
            : {}),
          ...(options?.getEffectiveModelCapabilities
            ? { effectiveModelCapabilities: options.getEffectiveModelCapabilities() }
            : {}),
          runtimeMode: input.runtimeMode,
          ...(input.model !== undefined ? { model: input.model } : {}),
          ...codexServiceTierOptions(
            resolveCodexSelectionOptions({
              modelOptions: input.modelOptions,
              modelSelection: input.modelSelection,
              boundInstanceId,
            }).fastMode,
            inheritsFastMode(input.model ?? input.modelSelection?.model),
          ),
          ...(providerMcpServers
            ? { mcpServers: translateMcpForCodex(providerMcpServers) ?? {} }
            : {}),
          ...(previewMcpSession || computerMcpSession || threadMcpSession
            ? {
                mcpEnvironment: {
                  ...previewMcpSession?.env,
                  ...computerMcpSession?.env,
                  ...threadMcpSession?.env,
                },
              }
            : {}),
          ...(chromeInstructions ? { integrationInstructions: [chromeInstructions] } : {}),
          ...(mcpOAuthCallbackConfig.port
            ? { mcpOAuthCallbackPort: mcpOAuthCallbackConfig.port }
            : {}),
          ...(mcpOAuthCallbackConfig.url
            ? { mcpOAuthCallbackUrl: mcpOAuthCallbackConfig.url }
            : {}),
        };

        return yield* Effect.tryPromise({
          try: (signal) => {
            automationGenerations.set(input.threadId, input.mcpEventIdentity?.sessionGeneration);
            return manager.startSession(managerInput, signal);
          },
          catch: (cause) =>
            new ProviderAdapterProcessError({
              provider: PROVIDER,
              threadId: input.threadId,
              detail: toMessage(cause, "Failed to start Codex adapter session."),
              cause,
            }),
        }).pipe(
          Effect.map((session) => ({ ...session, ...computerSessionFields(input.threadId) })),
          Effect.tap(() =>
            Effect.sync(() => {
              launchedMcpConfigKeys.set(
                input.threadId,
                stableMcpConfigKey(translateMcpForCodex(baseProviderMcpServers) ?? {}),
              );
            }),
          ),
        );
      }).pipe(Effect.tapError(() => Effect.sync(disposePreviewMcpSession)));
    };

    const sendTurn: CodexAdapterShape["sendTurn"] = (input) =>
      Effect.gen(function* () {
        if (incompleteThreads.has(input.threadId))
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "turn/start",
            detail: "Provider output is incomplete. Reconcile native history before continuing.",
            deliveryCertainty: "not_sent",
            deliveryRetryable: false,
          });
        const codexAttachments = yield* Effect.forEach(
          (input.attachments ?? []).filter((attachment) => attachment.type === "image"),
          (attachment) =>
            Effect.gen(function* () {
              switch (attachment.type) {
                case "image": {
                  const attachmentPath = resolveAttachmentPath({
                    attachmentsDir: serverConfig.attachmentsDir,
                    attachment,
                  });
                  if (!attachmentPath) {
                    return yield* toRequestError(
                      input.threadId,
                      "turn/start",
                      new Error(`Invalid attachment id '${attachment.id}'.`),
                    );
                  }
                  return { type: "localImage" as const, path: attachmentPath };
                }
                default:
                  throw new Error(
                    `Unsupported Codex attachment type '${String((attachment as { type?: unknown }).type)}'.`,
                  );
              }
            }),
          { concurrency: 1 },
        );
        const audioAttachments = (input.resolvedAttachments ?? []).filter((attachment) =>
          attachment.mimeType.toLowerCase().startsWith("audio/"),
        );
        const nativeAttachments = [...codexAttachments];
        const providerInput = appendProviderAttachmentRuntimeContext(
          input.mcpAppContext ? `${input.input ?? ""}${input.mcpAppContext}` : input.input,
          input.resolvedAttachments ?? [],
        );

        const selectionOptions = resolveCodexSelectionOptions({
          modelOptions: input.modelOptions,
          modelSelection: input.modelSelection,
          boundInstanceId,
        });
        const model =
          input.model ??
          (input.modelSelection?.instanceId === boundInstanceId
            ? input.modelSelection.model
            : undefined);
        const inheritedFastMode = inheritsFastMode(model);
        // Only a turn that states Codex options can turn fast mode off; turns
        // without any (some internal callers) keep the thread's tier.
        const statesCodexOptions =
          input.modelSelection?.instanceId === boundInstanceId ||
          input.modelOptions?.codex !== undefined;

        return yield* Effect.tryPromise({
          try: async () => {
            // A new turn restarts Chrome's runtime if it was stopped while idle or paused,
            // and waits (bounded) until main supervises it; one that isn't supervised by
            // then is stopped, so the model never reaches an unsupervised runtime.
            // Steering joins a turn that already has it.
            const chrome = input.expectedTurnId
              ? undefined
              : chromeSessions.get(input.threadId)?.session;
            await chrome?.beforeTurn();
            const managerInput = {
              threadId: input.threadId,
              ...(input.expectedTurnId ? { expectedTurnId: input.expectedTurnId } : {}),
              ...(providerInput !== undefined ? { input: providerInput } : {}),
              ...(input.model !== undefined ? { model: input.model } : {}),
              ...(selectionOptions.cyberAccessProgram
                ? { cyberAccessProgram: selectionOptions.cyberAccessProgram }
                : {}),
              ...(selectionOptions.reasoningEffort !== undefined
                ? { effort: selectionOptions.reasoningEffort }
                : {}),
              // Cached global config is display-only. Null asks the manager to undo
              // F5's previous override; otherwise it omits the native tier entirely.
              ...(selectionOptions.fastMode === true
                ? { serviceTier: "fast" as const }
                : selectionOptions.fastMode === false && inheritedFastMode
                  ? { serviceTier: "default" as const }
                  : statesCodexOptions
                    ? { serviceTier: null }
                    : {}),
              ...(input.interactionMode !== undefined
                ? { interactionMode: input.interactionMode }
                : {}),
              ...(nativeAttachments.length > 0 ? { attachments: nativeAttachments } : {}),
              ...(audioAttachments.length > 0
                ? { audioFiles: audioAttachments.map((attachment) => attachment.localPath) }
                : {}),
            };
            try {
              return await manager.sendTurn(managerInput);
            } catch (error) {
              // No turn started, so none will end: let the idle stop run again.
              chrome?.turnAborted();
              throw error;
            }
          },
          catch: (cause) => toRequestError(input.threadId, "turn/start", cause),
        }).pipe(
          Effect.map((result) => ({
            ...result,
            threadId: input.threadId,
          })),
        );
      });

    const generatedImages = new CodexGeneratedImages();
    const interruptTurn: CodexAdapterShape["interruptTurn"] = (threadId, turnId) =>
      Effect.tryPromise({
        try: async () => {
          generatedImages.cancel(threadId, turnId);
          const chrome = chromeSessions.get(threadId)?.session;
          // Read before Codex reports the interrupted call completed.
          const callRunning = chrome?.callRunning ?? false;
          // A call still driving Chrome stops with its runtime now, whether or not the
          // interrupt then succeeds; otherwise the interrupted turn drains through the
          // runtime's own hook.
          if (callRunning) chrome?.turnInterrupted(turnId, true);
          const result = await manager.interruptTurn(threadId, turnId);
          if (!callRunning) chromeSessions.get(threadId)?.session?.turnInterrupted(turnId, false);
          return result;
        },
        catch: (cause) => toRequestError(threadId, "turn/interrupt", cause),
      });

    const readThread: CodexAdapterShape["readThread"] = (threadId) =>
      Effect.tryPromise({
        try: () => manager.readThread(threadId),
        catch: (cause) => toRequestError(threadId, "thread/read", cause),
      }).pipe(
        Effect.map((snapshot) => ({
          threadId,
          turns: snapshot.turns,
          history: {
            identity: snapshot.threadId,
            provenance: "provider-persisted" as const,
            coverage: snapshot.historyCoverage ?? "partial",
            boundary: snapshot.turns.at(0)?.id ?? null,
            runtimeId: null,
          },
        })),
      );

    const rollbackThread: CodexAdapterShape["rollbackThread"] = (threadId, numTurns, options) => {
      if (!Number.isInteger(numTurns) || numTurns < 1) {
        return Effect.fail(
          new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "rollbackThread",
            issue: "numTurns must be an integer >= 1.",
          }),
        );
      }

      return Effect.tryPromise({
        try: () =>
          manager.rollbackThread(
            threadId,
            numTurns,
            options?.beforeTurnId,
            options?.onAdoptSession,
          ),
        catch: (cause) =>
          toRequestError(
            threadId,
            cause instanceof CodexJsonRpcError ? cause.method : "thread/revert",
            cause,
          ),
      }).pipe(
        Effect.map((snapshot) => ({
          threadId,
          turns: snapshot.turns,
        })),
      );
    };

    const runOneOffPrompt: CodexAdapterShape["runOneOffPrompt"] = (input) => {
      if (input.provider !== PROVIDER) {
        return Effect.fail(
          new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "runOneOffPrompt",
            issue: `Expected provider '${PROVIDER}' but received '${input.provider}'.`,
          }),
        );
      }

      return Effect.tryPromise({
        try: () =>
          manager.runOneOffPrompt({
            prompt: input.prompt,
            ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
            ...(input.modelSelection
              ? (() => {
                  const selectionOptions = resolveCodexSelectionOptions({
                    modelSelection: input.modelSelection,
                    boundInstanceId: input.modelSelection.instanceId,
                  });
                  return {
                    model: input.modelSelection.model,
                    effort: selectionOptions.reasoningEffort,
                    ...codexServiceTierOptions(
                      selectionOptions.fastMode,
                      inheritsFastMode(input.modelSelection.model),
                    ),
                  };
                })()
              : input.model !== undefined
                ? { model: input.model }
                : {}),
            ...(input.runtimeMode !== undefined ? { runtimeMode: input.runtimeMode } : {}),
            ...(input.providerOptions !== undefined || input.modelSelection !== undefined
              ? {
                  providerOptions: input.modelSelection
                    ? mergeCodexProviderOptions(
                        options?.defaultProviderOptions,
                        input.providerOptions,
                      )
                    : input.providerOptions,
                }
              : {}),
            ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
          }),
        catch: (cause) => toRequestError(input.threadId, "runOneOffPrompt", cause),
      }).pipe(Effect.map((text) => ({ text })));
    };

    const respondToRequest: CodexAdapterShape["respondToRequest"] = (
      threadId,
      requestId,
      decision,
    ) =>
      Effect.tryPromise({
        try: () => manager.respondToRequest(threadId, requestId, decision),
        catch: (cause) => toRequestError(threadId, "item/requestApproval/decision", cause),
      });

    const respondToUserInput: CodexAdapterShape["respondToUserInput"] = (
      threadId,
      requestId,
      answers,
    ) =>
      Effect.tryPromise({
        try: () => manager.respondToUserInput(threadId, requestId, answers),
        catch: (cause) => toRequestError(threadId, "item/tool/requestUserInput", cause),
      });

    const respondToElicitation: NonNullable<CodexAdapterShape["respondToElicitation"]> = (
      threadId,
      requestId,
      response,
    ) =>
      Effect.tryPromise({
        try: () => manager.respondToElicitation(threadId, requestId, response),
        catch: (cause) => toRequestError(threadId, "mcpServer/elicitation/request", cause),
      });

    const stopSession: CodexAdapterShape["stopSession"] = (threadId) =>
      Effect.sync(() => {
        threadMcpSessions.get(threadId)?.dispose();
        threadMcpSessions.delete(threadId);
        previewMcpSessions.get(threadId)?.dispose();
        previewMcpSessions.delete(threadId);
        disposeChromeSession(threadId);
        chromeFingerprints.delete(threadId);
        computerMcpSessions.get(threadId)?.dispose();
        computerMcpSessions.delete(threadId);
        computerDecisions.delete(threadId);
        launchedMcpConfigKeys.delete(threadId);
        manager.stopSession(threadId);
      });

    const listSessions: CodexAdapterShape["listSessions"] = () =>
      Effect.sync(() =>
        manager
          .listSessions()
          .map((session) => ({ ...session, ...computerSessionFields(session.threadId) })),
      );

    const hasSession: CodexAdapterShape["hasSession"] = (threadId) =>
      Effect.sync(() => manager.hasSession(threadId));

    const getSessionDiscovery: NonNullable<CodexAdapterShape["getSessionDiscovery"]> = (threadId) =>
      Effect.sync(() => manager.getSessionDiscovery?.(threadId));

    const builtInMcpServerNames = (threadId: ThreadId) =>
      new Set(
        [
          previewMcpSessions.get(threadId)?.serverName,
          computerMcpSessions.get(threadId)?.serverName,
          chromeSessions.get(threadId)?.serverDefinition ? CODEX_CHROME_SERVER_NAME : undefined,
        ].filter((name): name is string => Boolean(name)),
      );

    const getMcpServerStatuses: NonNullable<CodexAdapterShape["getMcpServerStatuses"]> = (
      threadId,
    ) =>
      Effect.tryPromise({
        try: () =>
          mcpProviderReads.read(
            JSON.stringify([
              "codex",
              mcpContextKey(manager.getMcpObservationContext(threadId)),
              threadId,
            ]),
            async (signal, deadline) => {
              const pages = await manager.getMcpServerStatuses(threadId, { signal, deadline });
              const launched = launchedMcpConfigKeys.get(threadId);
              const owned = new Set<string>(
                launched ? Object.keys(JSON.parse(launched) as object) : [],
              );
              const builtIns = builtInMcpServerNames(threadId);
              return {
                servers: observeCodexMcpServers(pages.entries, owned, builtIns),
                complete: pages.complete,
                ...(pages.anomaly ? { omissions: [pages.anomaly] } : {}),
                capabilities: { tools: true, inputSchemas: true, resources: true },
              };
            },
          ),
        catch: (cause) => toRequestError(threadId, "mcpServerStatus/list", cause),
      });

    const reloadMcpConfig: CodexAdapterShape["reloadMcpConfig"] = ({ threadId, mcpServers }) =>
      Effect.gen(function* () {
        yield* Effect.try({
          try: () => {
            assertMcpRuntimeConfig(mcpServers, PROVIDER);
            readCodexMcpOAuthCallbackConfig(mcpServers);
          },
          catch: (cause) =>
            new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "reloadMcpConfig",
              issue: mcpConfigErrorMessage(cause),
            }),
        });
        const launched = launchedMcpConfigKeys.get(threadId);
        if (
          launched !== undefined &&
          launched !== stableMcpConfigKey(translateMcpForCodex(mcpServers) ?? {})
        ) {
          // This also applies after login: never reload a launch config that differs
          // from the saved snapshot. Credentials take effect at the safe restart boundary.
          return restartRequiredMcpReload("Codex fixes its MCP servers when the session starts.");
        }
        const statuses = yield* Effect.tryPromise({
          try: () => manager.reloadMcpConfig(threadId),
          catch: (cause) => toRequestError(threadId, "config/mcpServer/reload", cause),
        });
        return summarizeMcpReload({
          desired: Object.keys(filterEnabledMcpServers(mcpServers)),
          observed:
            statuses === undefined
              ? undefined
              : observeCodexMcpServers(
                  statuses.flatMap((status) => {
                    const decoded = decodeCodexMcpServerStatus(status);
                    return decoded ? [decoded] : [];
                  }),
                  new Set(Object.keys(filterEnabledMcpServers(mcpServers))),
                  builtInMcpServerNames(threadId),
                ),
          sameName: codexServerNamesMatch,
        });
      });

    const stopAll: CodexAdapterShape["stopAll"] = () =>
      Effect.promise(async () => {
        for (const session of previewMcpSessions.values()) {
          session.dispose();
        }
        previewMcpSessions.clear();
        for (const threadId of [...chromeSessions.keys()]) disposeChromeSession(threadId);
        chromeFingerprints.clear();
        for (const session of threadMcpSessions.values()) session.dispose();
        threadMcpSessions.clear();
        for (const session of computerMcpSessions.values()) session.dispose();
        computerMcpSessions.clear();
        computerDecisions.clear();
        launchedMcpConfigKeys.clear();
        const deadline = Option.getOrUndefined(shutdown)?.deadline ?? Date.now() + 1_800;
        if (typeof manager.shutdown === "function") await manager.shutdown(deadline);
        else manager.stopAll();
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            Promise.all([...eventPreparation.values()]),
            new Promise<void>((resolve) => {
              timer = setTimeout(resolve, Math.max(0, deadline - Date.now()));
            }),
          ]);
        } finally {
          if (timer) clearTimeout(timer);
        }
        if (preparationControllers.size) {
          const pending = preparationControllers.size;
          for (const controller of preparationControllers) controller.abort();
          throw new Error(
            `Codex shutdown left ${pending} admitted event preparation(s) incomplete.`,
          );
        }
      });

    const appSql = yield* Effect.serviceOption(SqlClient.SqlClient);
    const appFs = yield* Effect.serviceOption(FileSystem.FileSystem);
    const appPath = yield* Effect.serviceOption(Path.Path);
    const appCaptures = new Map<ThreadId, number>();
    const capturePermit = yield* Semaphore.make(2);
    let captureCount = 0;
    const runtimeEventQueue = yield* Queue.bounded<{
      event: ProviderRuntimeEvent;
      units: number;
      lease: symbol;
      bytes: number;
    }>(1024);
    const runtimeEventBudget = yield* Semaphore.make(512);
    const canonicalQueueResources = new Map<symbol, { bytes: number; admittedAt: number }>();
    const offerRuntimeEvent = (event: ProviderRuntimeEvent) =>
      Effect.gen(function* () {
        const bytes = Buffer.byteLength(JSON.stringify(event));
        const units = Math.min(512, Math.max(1, Math.ceil(bytes / (64 * 1024))));
        const lease = Symbol();
        let transferred = false;
        yield* Effect.acquireUseRelease(
          runtimeEventBudget.take(units),
          () =>
            Effect.sync(() =>
              canonicalQueueResources.set(lease, { bytes, admittedAt: Date.now() }),
            ).pipe(
              Effect.andThen(Queue.offer(runtimeEventQueue, { event, units, lease, bytes })),
              Effect.tap((accepted) =>
                Effect.sync(() => {
                  transferred = accepted;
                }),
              ),
            ),
          () =>
            transferred
              ? Effect.void
              : Effect.sync(() => canonicalQueueResources.delete(lease)).pipe(
                  Effect.andThen(runtimeEventBudget.release(units)),
                ),
        );
      });
    const notificationAdmission = new NotificationAdmission(options?.notificationLimits);
    const incompleteThreads = new Map<ThreadId, { eventId: string; contextKey: string }>();
    const incompleteContexts = new Set<string>();
    const unregisterQueueResources = registerNotificationQueueResources(() => {
      const native = notificationAdmission.snapshot();
      const canonical = [...canonicalQueueResources.values()];
      return {
        entries: native.entries + native.controls + native.diagnostics + canonical.length,
        bytes: native.bytes + canonical.reduce((sum, entry) => sum + entry.bytes, 0),
        oldestAgeMs: Math.max(
          native.oldestAgeMs,
          ...canonical.map((entry) => Date.now() - entry.admittedAt),
        ),
      };
    });
    yield* Effect.addFinalizer(() => Effect.sync(unregisterQueueResources));
    const prepareRuntimeEvent = yield* makeAutomationRuntimeEventPreparer;
    const importGeneratedImage = yield* makeCodexGeneratedImageStore;

    const eventPreparation = new Map<string, Promise<void>>();
    const preparationControllers = new Set<AbortController>();
    const turnStartedAtByThread = new Map<string, string>();
    const reasoningTokenBaselineByThread = new Map<string, number>();
    const turnUsage = new CodexTurnUsage();
    const terminalFailureByThread = new Map<
      string,
      { readonly turnId: string; readonly evidence: CodexTerminalFailureEvidence }
    >();
    const limitsByThread = new Map<
      string,
      Map<string, { snapshot: CodexLimitSnapshot; observedAt: string }>
    >();

    yield* Effect.acquireRelease(
      Effect.gen(function* () {
        const writeNativeEvent = (event: ProviderEvent, merged?: PendingDeltaSlot) =>
          Effect.gen(function* () {
            if (!nativeEventLogger) {
              return;
            }
            const sanitized = automationEventSanitizer.sanitize(event.threadId, event);
            // A merged notification names how many native deltas it carries and the last
            // one, so a log taken during a burst still shows the real notification sequence.
            yield* writeProviderEventLog(
              nativeEventLogger,
              merged && merged.parts.length > 1
                ? {
                    ...(sanitized as Record<string, unknown>),
                    coalesced: {
                      count: merged.parts.length,
                      lastEventId: merged.last?.id,
                      lastCreatedAt: merged.last?.createdAt,
                    },
                  }
                : sanitized,
              event.threadId,
            );
          });

        const services = yield* Effect.services<never>();
        // Per context, the one waiting (unprepared) notification of each item
        // that later deltas of the same item may still merge into.
        const openDeltaSlots = new Map<string, Map<string, PendingDeltaSlot>>();
        const openDiagnostics = new Map<string, StderrDiagnosticBatch>();
        const omittedDiagnostics = new Map<string, number>();
        const reportOmittedDiagnostics = (key: string, reason: string) =>
          Effect.gen(function* () {
            const omittedLines = omittedDiagnostics.get(key);
            omittedDiagnostics.delete(key);
            if (omittedLines) {
              yield* Effect.logDebug("Codex stderr lines omitted without a later diagnostic", {
                contextKey: key,
                omittedLines,
                reason,
              });
            }
          });
        const markIncomplete = (event: ProviderEvent) => {
          const key = notificationContextKey(event);
          openDeltaSlots.delete(key);
          openDiagnostics.delete(key);
          if (incompleteContexts.has(key)) return;
          incompleteContexts.add(key);
          Effect.runSync(Metric.update(providerNotificationOverflows, 1));
          const eventId = `incomplete:${event.id}`;
          const liveGeneration = automationGenerations.get(event.threadId);
          const ownsCurrent =
            liveGeneration === undefined ||
            event.sessionGeneration === undefined ||
            liveGeneration === event.sessionGeneration;
          if (ownsCurrent) {
            incompleteThreads.set(event.threadId, { eventId, contextKey: key });
            // A retired context must never interrupt its replacement.
            void manager
              .interruptTurn(
                event.threadId,
                event.turnId ? TurnId.makeUnsafe(String(event.turnId)) : undefined,
              )
              .catch(() => {});
          }
          const previous = eventPreparation.get(key) ?? Promise.resolve();
          const reportController = new AbortController();
          preparationControllers.add(reportController);
          const report = () =>
            Effect.runPromiseWith(services)(
              offerRuntimeEvent({
                type: "runtime.error",
                eventId: EventId.makeUnsafe(eventId),
                provider: PROVIDER,
                threadId: event.threadId,
                createdAt: event.createdAt,
                ...(event.turnId ? { turnId: TurnId.makeUnsafe(String(event.turnId)) } : {}),
                ...(event.providerInstanceId !== undefined
                  ? { providerInstanceId: event.providerInstanceId }
                  : {}),
                ...(event.sessionGeneration !== undefined
                  ? { sessionGeneration: event.sessionGeneration }
                  : {}),
                payload: {
                  class: "transport_error",
                  historyReconciliationRequired: true,
                  message:
                    "Provider output is incomplete because notification admission was exhausted. Native history must be reconciled before continuing.",
                },
              }),
              { signal: reportController.signal },
            );
          const next = previous.then(report, report);
          eventPreparation.set(key, next);
          void next
            .finally(() => {
              preparationControllers.delete(reportController);
              if (eventPreparation.get(key) === next) eventPreparation.delete(key);
            })
            .catch(() => {});
        };
        const listener = (event: ProviderEvent) => {
          if (automationGenerations.get(event.threadId) === event.sessionGeneration) {
            const chromeSession = chromeSessions.get(event.threadId)?.session;
            if (chromeSession) trackCodexChromeCall(chromeSession, event);
          }
          const diagnostic =
            event.method === "process/stderr" &&
            !isFatalCodexProcessStderrMessage(event.message ?? "");
          if (diagnostic && isIgnorableCodexProcessStderrMessage(event.message ?? "")) return;
          const liveGeneration = automationGenerations.get(event.threadId);
          if (
            diagnostic &&
            liveGeneration !== undefined &&
            liveGeneration !== event.sessionGeneration
          ) {
            return;
          }
          // Turn/session terminals are always admitted: they are the only events
          // that settle a turn, including the one an overflow interrupt produces.
          // Other session/error events (parse errors, stderr, config) can arrive
          // in floods, so they stay in the count-capped control lane.
          const terminal =
            !diagnostic &&
            (event.method === "turn/completed" ||
              event.method === "session/exited" ||
              event.method === "session/closed");
          const control =
            terminal ||
            (!diagnostic &&
              (event.kind === "session" ||
                event.kind === "error" ||
                /(?:completed|closed|exited|started|requestApproval|requestUserInput)$/.test(
                  event.method,
                )));
          const key = notificationContextKey(event);
          if (incompleteContexts.has(key) && !control) return;
          let diagnosticBatch: StderrDiagnosticBatch | undefined;
          if (diagnostic) {
            const waiting = openDiagnostics.get(key);
            if (waiting) {
              openDeltaSlots.delete(key);
              waiting.append(event.message ?? "Codex process stderr");
              return eventPreparation.get(key);
            }
            diagnosticBatch = new StderrDiagnosticBatch(event, omittedDiagnostics.get(key));
            // Do not close over the original, potentially enormous stderr message.
            event = diagnosticBatch.first;
          } else {
            openDiagnostics.delete(key);
          }
          const bytes = Buffer.byteLength(JSON.stringify(event));
          const mergeable = mergeableContentDelta(event);
          const contextSlots = openDeltaSlots.get(key);
          if (mergeable) {
            // A delta joins its item's notification while that one still waits.
            // Only deltas of other items can pass it; anything else seals it.
            const slot = contextSlots?.get(mergeable.identity);
            if (slot) {
              const deltaBytes = Buffer.byteLength(mergeable.delta);
              // Only the text is kept, so only the text is charged: the event envelope
              // (hundreds of bytes per tiny chunk) is dropped when it merges.
              if (
                slot.textBytes + deltaBytes <= MAX_MERGED_DELTA_BYTES &&
                slot.lease.extend(deltaBytes)
              ) {
                slot.parts.push(mergeable.delta);
                slot.textBytes += deltaBytes;
                slot.last = { id: event.id, createdAt: event.createdAt };
                return slot.next;
              }
              contextSlots!.delete(mergeable.identity);
            }
          } else if (!diagnosticBatch) {
            openDeltaSlots.delete(key);
          }
          const lease = diagnosticBatch
            ? notificationAdmission.reserveDiagnostic(key, diagnosticBatch.reservationBytes)
            : notificationAdmission.reserve(
                key,
                bytes,
                terminal ? "terminal" : control ? "control" : "data",
              );
          if (!lease) {
            if (diagnosticBatch) {
              omittedDiagnostics.set(
                key,
                Math.min(Number.MAX_SAFE_INTEGER, (omittedDiagnostics.get(key) ?? 0) + 1),
              );
              return;
            }
            markIncomplete(event);
            return;
          }
          if (diagnosticBatch) {
            // Dropped diagnostics must not stop stdout deltas from merging.
            openDeltaSlots.delete(key);
            omittedDiagnostics.delete(key);
            openDiagnostics.set(key, diagnosticBatch);
          }
          const slot: PendingDeltaSlot | undefined = mergeable
            ? {
                first: event,
                parts: [mergeable.delta],
                textBytes: Buffer.byteLength(mergeable.delta),
                lease,
              }
            : undefined;
          if (slot && mergeable) {
            const slots = openDeltaSlots.get(key) ?? new Map();
            slots.set(mergeable.identity, slot);
            openDeltaSlots.set(key, slots);
          }
          // Retain synchronously at admission: asynchronous logging/image storage
          // can still be running when a replacement retires this provider process.
          const nativeItem =
            event.method === "item/completed" ? asObject(asObject(event.payload)?.item) : undefined;
          const appUri =
            asString(asObject(nativeItem?.mcpAppUi)?.resourceUri) ??
            asString(nativeItem?.mcpAppResourceUri);
          const eligibleApp =
            nativeItem?.type === "mcpToolCall" &&
            nativeItem.status === "completed" &&
            nativeItem.error == null &&
            captureCount < 8 &&
            (appCaptures.get(event.threadId) ?? 0) < 4;
          const initialResult =
            eligibleApp && appUri?.startsWith("ui://") && appUri.length <= 4096
              ? readMcpAppToolResult(nativeItem?.result)
              : undefined;
          const initialJson =
            nativeItem && initialResult
              ? stringifyWithinBytes(
                  { arguments: asObject(nativeItem.arguments) ?? {}, result: initialResult },
                  192 * 1024,
                )
              : undefined;
          const appBootstrap = initialJson
            ? (JSON.parse(initialJson) as Record<string, unknown>)
            : undefined;
          const appCapture = eligibleApp && appBootstrap !== undefined;
          let appIdentity: string | undefined;
          if (appCapture) {
            try {
              appIdentity = manager.getMcpAppSessionIdentity(event.threadId);
            } catch {
              /* Ordinary tool fallback. */
            }
          }
          let releaseAppCapture: (() => void) | undefined;
          if (appCapture) {
            // Captures run inside this session's ordered preparation, so later
            // output waits behind them; the caps bound how long that can be.
            captureCount++;
            appCaptures.set(event.threadId, (appCaptures.get(event.threadId) ?? 0) + 1);
            releaseAppCapture = () => {
              captureCount--;
              const pending = (appCaptures.get(event.threadId) ?? 1) - 1;
              if (pending > 0) appCaptures.set(event.threadId, pending);
              else appCaptures.delete(event.threadId);
            };
          }
          const releaseProvenance = automationEventSanitizer.retain(event.threadId);
          const controller = new AbortController();
          preparationControllers.add(controller);
          const previous = eventPreparation.get(key) ?? Promise.resolve();
          // `event` is shadowed so the body prepares the merged notification.
          const prepareEvent = (event: ProviderEvent) =>
            Effect.gen(function* () {
              if (isSyntheticOneOffThreadId(event.threadId)) {
                return;
              }
              yield* writeNativeEvent(event, slot);
              const completedUsage = turnUsage.observe(event);
              if (event.method === "turn/started") {
                turnStartedAtByThread.set(key, event.createdAt);
                terminalFailureByThread.delete(key);
              }
              const eventPayload = asObject(event.payload);
              if (event.method === "error" && event.turnId && eventPayload?.willRetry !== true) {
                const error = asObject(eventPayload?.error);
                terminalFailureByThread.set(key, {
                  turnId: event.turnId,
                  evidence: {
                    message: asString(error?.message) ?? event.message ?? "",
                    errorInfo: error?.codexErrorInfo,
                  },
                });
              }
              const cachedFailure = terminalFailureByThread.get(key);
              const previousFailure =
                event.method === "turn/completed" &&
                cachedFailure !== undefined &&
                cachedFailure.turnId === event.turnId
                  ? cachedFailure.evidence
                  : undefined;
              if (event.method === "turn/completed") terminalFailureByThread.delete(key);
              if (event.method === "account/rateLimits/updated") {
                const snapshot = asObject(asObject(event.payload)?.rateLimits);
                if (snapshot) {
                  const buckets = limitsByThread.get(key) ?? new Map();
                  const limitKey =
                    typeof snapshot.limitId === "string" ? snapshot.limitId : "codex";
                  const merged = mergeCodexLimitSnapshot(
                    buckets.get(limitKey)?.snapshot,
                    snapshot as CodexLimitSnapshot,
                  );
                  if (merged)
                    buckets.set(limitKey, { snapshot: merged, observedAt: event.createdAt });
                  limitsByThread.set(key, buckets);
                }
              }
              const ownsAutomation =
                automationGenerations.get(event.threadId) === event.sessionGeneration;
              const previewServerName = ownsAutomation
                ? previewMcpSessions.get(event.threadId)?.serverName
                : undefined;
              if (ownsAutomation && event.method === "turn/completed" && event.turnId)
                computerMcpSessions.get(event.threadId)?.endTurn?.(event.turnId);
              const chromeSession = ownsAutomation
                ? chromeSessions.get(event.threadId)?.session
                : undefined;
              if (chromeSession) observeCodexChrome(chromeSession, event);
              const imageEvent = yield* importGeneratedImage(event);
              let runtimeEvents = withAgentBrowserPreview(
                generatedImages
                  .project(imageEvent)
                  .flatMap((projected) =>
                    mapToRuntimeEvents(
                      projected,
                      event.threadId,
                      limitsByThread.get(key)?.get("codex")?.snapshot,
                      [...(limitsByThread.get(key)?.values() ?? [])],
                      turnStartedAtByThread.get(key),
                      previousFailure,
                    ),
                  ),
                previewServerName,
                ownsAutomation ? computerMcpSessions.get(event.threadId)?.serverName : undefined,
                ownsAutomation ? computerDecisions.get(event.threadId) : undefined,
                ownsAutomation ? chromeSessions.get(event.threadId)?.state : undefined,
              );
              if (completedUsage !== undefined) {
                runtimeEvents = runtimeEvents.map((runtimeEvent) =>
                  runtimeEvent.type === "turn.completed" && runtimeEvent.payload.usage === undefined
                    ? {
                        ...runtimeEvent,
                        payload: { ...runtimeEvent.payload, usage: completedUsage },
                      }
                    : runtimeEvent,
                );
              }
              if (event.method === "thread/tokenUsage/updated") {
                const reasoning = codexReasoningTokensSinceBaseline(
                  asObject(event.payload),
                  reasoningTokenBaselineByThread.get(key),
                );
                if (reasoning) {
                  if (reasoning.baseline !== undefined)
                    reasoningTokenBaselineByThread.set(key, reasoning.baseline);
                  if (reasoning.tokens > 0 && event.turnId) {
                    runtimeEvents = [
                      ...runtimeEvents,
                      {
                        ...runtimeEventBase(event, event.threadId),
                        eventId: EventId.make(`${event.id}:reasoning-tokens`),
                        turnId: event.turnId,
                        type: "turn.reasoning-tokens.reported",
                        payload: { tokens: reasoning.tokens, estimated: false },
                      },
                    ];
                  }
                }
              }
              if (
                appCapture &&
                nativeItem &&
                appUri &&
                appIdentity &&
                Option.isSome(appSql) &&
                Option.isSome(appFs) &&
                Option.isSome(appPath)
              ) {
                const server = asString(nativeItem.server),
                  tool = asString(nativeItem.tool);
                if (server && tool) {
                  const reference = yield* capturePermit
                    .withPermits(1)(
                      Effect.tryPromise({
                        try: () =>
                          manager.readMcpAppResource(event.threadId, server, appUri, appIdentity, {
                            originCallId: String(nativeItem.id),
                            ...(asString(asObject(nativeItem.appContext)?.connectorId)
                              ? {
                                  target: {
                                    connectorId: asString(
                                      asObject(nativeItem.appContext)?.connectorId,
                                    )!,
                                    linkId:
                                      asString(asObject(nativeItem.appContext)?.linkId) ?? null,
                                  },
                                }
                              : {}),
                          }),
                        catch: (cause) =>
                          toRequestError(event.threadId, "mcpServer/resource/read", cause),
                      }).pipe(
                        Effect.flatMap((response) =>
                          snapshotMcpApp({
                            attachmentsDir: serverConfig.attachmentsDir,
                            threadId: event.threadId,
                            activityId: `${event.id}:mcp-app`,
                            itemKey: `mcp-app:${String(nativeItem.id)}`,
                            server,
                            tool,
                            resourceUri: appUri,
                            originCallId: String(nativeItem.id),
                            ...(asString(asObject(nativeItem.appContext)?.connectorId)
                              ? {
                                  target: {
                                    connectorId: asString(
                                      asObject(nativeItem.appContext)?.connectorId,
                                    )!,
                                    linkId:
                                      asString(asObject(nativeItem.appContext)?.linkId) ?? null,
                                  },
                                }
                              : {}),
                            response,
                            provider: "codex",
                          }),
                        ),
                        Effect.provideService(SqlClient.SqlClient, appSql.value),
                        Effect.provideService(FileSystem.FileSystem, appFs.value),
                        Effect.provideService(Path.Path, appPath.value),
                      ),
                    )
                    .pipe(
                      Effect.timeout("10 seconds"),
                      Effect.catchCause((cause) =>
                        Cause.hasInterruptsOnly(cause)
                          ? Effect.interrupt
                          : Effect.succeed(undefined),
                      ),
                    );
                  if (reference)
                    runtimeEvents = runtimeEvents.map((item) =>
                      item.type === "item.completed"
                        ? {
                            ...item,
                            payload: {
                              ...item.payload,
                              data: {
                                ...asObject(item.payload.data),
                                mcpApp: reference,
                                mcpAppBootstrap: appBootstrap,
                              },
                            },
                          }
                        : item,
                    );
                }
              }
              // Redact at admission, before lifecycle cleanup removes provenance.
              const safeRuntimeEvents = yield* Effect.forEach(runtimeEvents, (runtimeEvent) =>
                prepareRuntimeEvent({
                  ...runtimeEvent,
                  ...(event.providerInstanceId !== undefined
                    ? { providerInstanceId: event.providerInstanceId }
                    : {}),
                  ...(event.sessionGeneration !== undefined
                    ? { sessionGeneration: event.sessionGeneration }
                    : {}),
                }),
              );
              if (event.method === "session/exited" || event.method === "session/closed") {
                if (ownsAutomation) {
                  disposeChromeSession(event.threadId);
                  computerMcpSessions.get(event.threadId)?.dispose();
                  computerMcpSessions.delete(event.threadId);
                  computerDecisions.delete(event.threadId);
                  automationGenerations.delete(event.threadId);
                }
                incompleteContexts.delete(key);
                openDiagnostics.delete(key);
                yield* reportOmittedDiagnostics(key, event.method);
                limitsByThread.delete(key);
                turnStartedAtByThread.delete(key);
                reasoningTokenBaselineByThread.delete(key);
                terminalFailureByThread.delete(key);
              }
              if (runtimeEvents.length === 0) {
                yield* Effect.logDebug("ignoring unhandled Codex provider event", {
                  method: event.method,
                  threadId: event.threadId,
                  turnId: event.turnId,
                  itemId: event.itemId,
                });
                return;
              }
              const liveGeneration = automationGenerations.get(event.threadId);
              if (
                diagnosticBatch &&
                liveGeneration !== undefined &&
                liveGeneration !== event.sessionGeneration
              ) {
                yield* reportOmittedDiagnostics(key, "generation retired during preparation");
                return;
              }
              yield* Effect.forEach(safeRuntimeEvents, offerRuntimeEvent, {
                concurrency: 1,
                discard: true,
              });
            }).pipe(
              Effect.catchCause((cause) =>
                Cause.hasInterruptsOnly(cause)
                  ? Effect.interrupt
                  : Effect.gen(function* () {
                      if (diagnosticBatch) {
                        yield* Effect.logWarning(
                          "Codex diagnostic preparation failed; dropping diagnostic",
                          {
                            threadId: event.threadId,
                            eventId: event.id,
                            cause,
                          },
                        );
                        return;
                      }
                      yield* Effect.logError(
                        "Codex event preparation failed; history reconciliation required",
                        { threadId: event.threadId, eventId: event.id, cause },
                      );
                      markIncomplete(event);
                      yield* offerRuntimeEvent({
                        type: "runtime.error",
                        eventId: EventId.makeUnsafe(`prepare:${event.id}`),
                        provider: PROVIDER,
                        threadId: event.threadId,
                        createdAt: event.createdAt,
                        ...(event.providerInstanceId !== undefined
                          ? { providerInstanceId: event.providerInstanceId }
                          : {}),
                        ...(event.sessionGeneration !== undefined
                          ? { sessionGeneration: event.sessionGeneration }
                          : {}),
                        payload: {
                          class: "transport_error",
                          message:
                            "Provider output could not be prepared. Reconcile history before continuing.",
                        },
                      });
                    }),
              ),
              (effect) => Effect.runPromiseWith(services)(effect, { signal: controller.signal }),
            );
          const prepare = () => {
            if (diagnosticBatch) {
              if (openDiagnostics.get(key) === diagnosticBatch) openDiagnostics.delete(key);
              const generation = automationGenerations.get(event.threadId);
              // Retired diagnostics are disposable, unlike authoritative turn output.
              if (generation !== undefined && generation !== event.sessionGeneration) {
                return Effect.runPromiseWith(services)(
                  reportOmittedDiagnostics(key, "generation retired before preparation"),
                );
              }
              return prepareEvent(diagnosticBatch.toEvent());
            }
            if (!slot) return prepareEvent(event);
            // Seal at preparation start: later deltas form a new notification.
            const slots = openDeltaSlots.get(key);
            if (slots && mergeable && slots.get(mergeable.identity) === slot) {
              slots.delete(mergeable.identity);
              if (slots.size === 0) openDeltaSlots.delete(key);
            }
            return prepareEvent(mergeContentDeltas(slot.first, slot.parts));
          };
          const next = previous.then(prepare, prepare);
          if (slot) slot.next = next;
          eventPreparation.set(key, next);
          void next
            .finally(() => {
              lease.release();
              releaseProvenance();
              releaseAppCapture?.();
              preparationControllers.delete(controller);
              if (eventPreparation.get(key) === next) eventPreparation.delete(key);
            })
            .catch(() => {});
          return next;
        };
        yield* Effect.addFinalizer(() =>
          Effect.forEach(
            [...omittedDiagnostics.keys()],
            (key) => reportOmittedDiagnostics(key, "adapter shutdown"),
            { discard: true },
          ).pipe(Effect.andThen(Effect.sync(() => openDiagnostics.clear()))),
        );
        manager.on("event", listener);
        return listener;
      }),
      (listener) =>
        Effect.gen(function* () {
          yield* Effect.sync(() => {
            manager.off("event", listener);
          });
          yield* Effect.promise(() => Promise.allSettled([...eventPreparation.values()])).pipe(
            Effect.timeoutOption(
              Math.max(
                0,
                (Option.getOrUndefined(shutdown)?.deadline ?? Date.now() + 1_800) - Date.now(),
              ),
            ),
          );
          if (preparationControllers.size > 0) {
            yield* Effect.logWarning("Codex event preparation did not drain before shutdown", {
              pending: preparationControllers.size,
            });
            for (const controller of preparationControllers) controller.abort();
            yield* Effect.promise(() => Promise.allSettled([...eventPreparation.values()]));
          }
          yield* Queue.shutdown(runtimeEventQueue);
        }),
    );

    /** Read-only preflight: never spawns, writes, or reads Codex config or credentials. */
    const getChromeReadiness: NonNullable<CodexAdapterShape["getChromeReadiness"]> = () =>
      Effect.promise(async () => {
        if (options?.computerAutomationBroker?.chromeRecoveryRequired())
          return {
            eligibility: "recovery-required" as const,
            reason: "Browser control from an earlier session hasn't stopped yet.",
          };
        let binaryPath: string;
        try {
          binaryPath = resolveCodexCommand(options?.defaultProviderOptions?.codex?.binaryPath);
        } catch (cause) {
          return {
            eligibility: "unavailable" as const,
            reason: cause instanceof Error ? cause.message : "Bundled Codex is unavailable.",
          };
        }
        const processEnvironment = options?.processEnvironment ?? process.env;
        const eligibility = await codexChromeEligibility({
          codexHome: effectiveCodexHome(
            resolveCodexHome({ homePath: options?.defaultProviderOptions?.codex?.homePath }),
            processEnvironment,
          ),
          userHome: userInfo().homedir,
          runtimeMode: "preflight",
          // The binary's path and signature only: the preflight never runs Codex.
          codex: await inspectCodexBinary({
            binaryPath,
            processEnvironment,
            cwd: process.cwd(),
            probeVersion: false,
          }),
        });
        return eligibility.eligible
          ? {
              eligibility: "ready" as const,
              reason: codexChromeReadyDetail(eligibility.installation),
              recordId: eligibility.installation.record.id,
            }
          : {
              eligibility: "unavailable" as const,
              reason: eligibility.reason,
              ...(eligibility.recordId ? { recordId: eligibility.recordId } : {}),
            };
      });

    return {
      provider: PROVIDER,
      capabilities: {
        sessionModelSwitch: "in-session",
        runtimeCapabilities: providerRuntimeCapabilities(PROVIDER),
        enforcesReadOnlyWorkflow: true,
      },
      getChromeReadiness,
      executeNativeOperation: (input, onReceipt) =>
        Effect.tryPromise({
          try: (signal) => manager.executeNativeOperation(input, onReceipt, signal),
          catch: (cause) => {
            if (
              input.command.kind === "aside" &&
              asObject(cause)?.nativeOperationCancelled === true
            )
              return Object.assign(toRequestError(input.threadId, input.command.kind, cause), {
                nativeOperationCancelled: true,
              });
            const error = toRequestError(input.threadId, input.command.kind, cause);
            if (
              cause &&
              typeof cause === "object" &&
              "deliveryCertainty" in cause &&
              cause.deliveryCertainty === "not_sent" &&
              Schema.is(ProviderAdapterRequestError)(error)
            )
              return new ProviderAdapterRequestError({
                ...error,
                deliveryCertainty: "not_sent",
              });
            return error;
          },
        }).pipe(
          Effect.onInterrupt(() =>
            input.command.kind === "aside"
              ? Effect.promise(() => manager.interruptTurn(input.threadId).catch(() => undefined))
              : Effect.void,
          ),
        ),
      markNativeThreadRead: (threadId) =>
        Effect.promise(() => manager.markNativeThreadRead(threadId)),
      inspectNativeOperation: (input) =>
        Effect.tryPromise({
          try: () => manager.inspectNativeOperation(input),
          catch: (cause) => toRequestError(input.threadId, "inspect", cause),
        }),
      readChildThreadItems: (threadId, childId, cursor, limit) =>
        Effect.tryPromise({
          try: () => manager.readChildThreadItems(threadId, childId, cursor, limit),
          catch: (cause) => toRequestError(threadId, "thread/items/list", cause),
        }),
      reconcileNativeOperation: (record) =>
        Effect.tryPromise({
          try: () => manager.reconcileNativeOperation(record),
          catch: (cause) => toRequestError(record.threadId, "reconcile", cause),
        }),
      renameThread: (threadId, title) =>
        Effect.tryPromise({
          try: () => manager.renameThread(threadId, title),
          catch: (cause) => toRequestError(threadId, "thread/name/set", cause),
        }),
      mcpApps: {
        identity: (threadId) =>
          Effect.try({
            try: () => manager.getMcpAppSessionIdentity(threadId),
            catch: (cause) => toRequestError(threadId, "mcpApps.identity", cause),
          }),
        listTools: ({ threadId, server }) =>
          Effect.tryPromise({
            try: async () => {
              const listing = await manager.getMcpServerStatuses(threadId, {
                deadline: Date.now() + 10000,
              });
              if (!listing.complete) throw new Error("MCP tool inventory is incomplete.");
              return Object.values(
                listing.entries.find((entry) => entry.name === server)?.tools ?? {},
              );
            },
            catch: (cause) => toRequestError(threadId, "mcpServerStatus/list", cause),
          }),
        callTool: ({ threadId, server, tool, arguments: args, sessionIdentity, approved }) =>
          Effect.tryPromise({
            try: () =>
              manager.callMcpAppTool(threadId, server, tool, args, sessionIdentity, approved),
            catch: (cause) => toRequestError(threadId, "mcpServer/tool/call", cause),
          }),
        readResource: ({ threadId, server, uri, originCallId, target }) =>
          Effect.tryPromise({
            try: () =>
              manager.readMcpAppResource(threadId, server, uri, undefined, {
                ...(originCallId ? { originCallId } : {}),
                ...(target ? { target } : {}),
              }),
            catch: (cause) => toRequestError(threadId, "mcpServer/resource/read", cause),
          }),
      },
      startSession,
      sendTurn,
      steerTurn: sendTurn,
      interruptTurn,
      readThread,
      rollbackThread,
      runOneOffPrompt,
      respondToRequest,
      respondToUserInput,
      respondToElicitation,
      stopSession,
      listSessions,
      hasSession,
      getSessionDiscovery,
      reloadMcpConfig,
      getMcpServerStatuses,
      getOwnedMcpServerNames: (threadId) =>
        Effect.sync(() =>
          Object.keys(JSON.parse(launchedMcpConfigKeys.get(threadId) ?? "{}") as object),
        ),
      stopAll,
      acknowledgeHistoryReconciliation: (threadId, markerId) =>
        Effect.sync(() => {
          const marker = incompleteThreads.get(threadId);
          if (marker?.eventId === markerId) {
            incompleteContexts.delete(marker.contextKey);
            incompleteThreads.delete(threadId);
          }
        }),
      streamEvents: Stream.fromQueue(runtimeEventQueue).pipe(
        Stream.mapEffect(({ event, units, lease }) =>
          Effect.sync(() => canonicalQueueResources.delete(lease)).pipe(
            Effect.andThen(runtimeEventBudget.release(units)),
            Effect.as(event),
          ),
        ),
      ),
    } satisfies CodexAdapterShape;
  });

export const CodexAdapterLive = Layer.effect(CodexAdapter, makeCodexAdapter());

export function makeCodexAdapterLive(options?: CodexAdapterLiveOptions) {
  return Layer.effect(CodexAdapter, makeCodexAdapter(options));
}
