import {
  HTML_RENDER_WS_METHODS,
  ProviderInstanceId,
  WS_CHANNELS,
  WS_METHODS,
} from "@t3tools/contracts";
import { integrationUnavailableDetail } from "@t3tools/shared/providerIntegrationCertification";
import { Effect, FileSystem, Option, Path, Struct } from "effect";
import type { WebSocket } from "ws";

import type { ComputerAutomationBroker } from "../../computer/ComputerAutomationBroker.ts";
import type { makeHtmlPreviewBroker } from "../../htmlRender/HtmlPreviewBroker.ts";
import type { PreviewAutomationBroker } from "../../mcp/PreviewAutomationBroker.ts";
import { increment, previewRecordingFramesDroppedTotal } from "../../observability/Metrics.ts";
import type { makePreviewManager } from "../../preview/Manager.ts";
import { scanLocalServers, type OwnedPreviewUrls } from "../../preview/PortScanner.ts";
import {
  isChromeRuntimeSession,
  listChromeSessionSetups,
  restoreChromeSessionSetup,
} from "../../provider/chromeSessionRuntimeFactory.ts";
import type { ProviderInstanceRegistry } from "../../provider/Services/ProviderInstanceRegistry.ts";
import type { ProviderService } from "../../provider/Services/ProviderService.ts";
import type { ServerSettingsService } from "../../serverSettings.ts";
import { RouteRequestError } from "../../turnSubmissionErrors.ts";
import type { makeServerPushBus } from "../pushBus.ts";
import type { RouteTable } from "./routeTable.ts";

type PreviewAndComputerMethod =
  | typeof WS_METHODS.previewOpen
  | typeof WS_METHODS.previewNavigate
  | typeof WS_METHODS.previewReportStatus
  | typeof WS_METHODS.previewReportRecordingMetrics
  | typeof WS_METHODS.previewRefresh
  | typeof WS_METHODS.previewClose
  | typeof WS_METHODS.previewList
  | typeof WS_METHODS.previewListLocalServers
  | typeof WS_METHODS.previewAutomationReportOwner
  | typeof WS_METHODS.previewAutomationClearOwner
  | typeof WS_METHODS.previewAutomationRespond
  | typeof WS_METHODS.previewAutomationSetPaused
  | typeof HTML_RENDER_WS_METHODS.host
  | typeof HTML_RENDER_WS_METHODS.respond
  | typeof WS_METHODS.computerChromeRelease
  | typeof WS_METHODS.computerAccessRevoke
  | typeof WS_METHODS.computerAccessList
  | typeof WS_METHODS.computerAccessListRemembered
  | typeof WS_METHODS.computerAccessForgetRemembered
  | typeof WS_METHODS.claudeChromeRestoreNativeHost
  | typeof WS_METHODS.codexChromeRestoreNativeHost
  | typeof WS_METHODS.chromeNativeHostListTransactions
  | typeof WS_METHODS.chromeGetReadiness;

export interface PreviewRouteDependencies {
  readonly stateDir: string;
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly previewManager: ReturnType<typeof makePreviewManager>;
  readonly previewAutomationBroker: typeof PreviewAutomationBroker.Service;
  readonly htmlPreviewBroker: ReturnType<typeof makeHtmlPreviewBroker>;
  readonly computerAutomationBroker: Option.Option<typeof ComputerAutomationBroker.Service>;
  readonly ownedPreviewUrls: OwnedPreviewUrls;
  readonly pushBus: Effect.Success<ReturnType<typeof makeServerPushBus>>;
  readonly providerService: typeof ProviderService.Service;
  readonly providerInstanceRegistry: typeof ProviderInstanceRegistry.Service;
  readonly serverSettings: typeof ServerSettingsService.Service;
  readonly previewAutomationClientIdsByWs: WeakMap<WebSocket, Map<string, string>>;
  readonly previewAutomationHostIdByWs: WeakMap<WebSocket, string>;
  readonly getPreviewAutomationHostId: (ws: WebSocket) => string;
  readonly getServerPreviewAutomationClientId: (ws: WebSocket, rendererClientId: string) => string;
  readonly authorizedPreviewAutomationClientIds: (ws: WebSocket) => ReadonlySet<string>;
}

const withoutTag = <Body extends { readonly _tag: string }>(body: Body) =>
  Struct.omit(body, ["_tag"]);

/**
 * Preview tabs, preview automation, HTML render hosting, computer-use access
 * control, and Chrome native-host readiness/recovery routes.
 */
export const previewRoutes = ({
  stateDir,
  fileSystem,
  path,
  previewManager,
  previewAutomationBroker,
  htmlPreviewBroker,
  computerAutomationBroker,
  ownedPreviewUrls,
  pushBus,
  providerService,
  providerInstanceRegistry,
  serverSettings,
  previewAutomationClientIdsByWs,
  previewAutomationHostIdByWs,
  getPreviewAutomationHostId,
  getServerPreviewAutomationClientId,
  authorizedPreviewAutomationClientIds,
}: PreviewRouteDependencies): RouteTable<PreviewAndComputerMethod, never, Error> => {
  const restoreChromeNativeHost = (provider: "claude" | "codex", transactionId: string) =>
    Effect.gen(function* () {
      const sessions = yield* providerService.listSessions();
      // Storage-only: works without a live runtime, after restarts and SDK upgrades.
      return yield* restoreChromeSessionSetup({
        stateDir,
        provider,
        transactionId,
        broker: Option.getOrUndefined(computerAutomationBroker),
        stopSessions: async () => {
          for (const session of sessions) {
            if (
              isChromeRuntimeSession(session.threadId) &&
              ((provider === "claude" && session.provider === "claudeAgent") ||
                (provider === "codex" && session.provider === "codex"))
            ) {
              await Effect.runPromise(providerService.stopSession({ threadId: session.threadId }));
            }
          }
        },
      }).pipe(
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
        Effect.catchDefect((cause) =>
          Effect.fail(
            new RouteRequestError({
              message: cause instanceof Error ? cause.message : "Chrome restoration failed.",
            }),
          ),
        ),
      );
    });

  return {
    [WS_METHODS.previewOpen]: (request) =>
      previewManager
        .open(withoutTag(request))
        .pipe(Effect.mapError((error) => new RouteRequestError({ message: error.message }))),

    [WS_METHODS.previewNavigate]: (request) =>
      previewManager
        .navigate(withoutTag(request))
        .pipe(Effect.mapError((error) => new RouteRequestError({ message: error.message }))),

    [WS_METHODS.previewReportStatus]: (request) =>
      previewManager
        .reportStatus(withoutTag(request))
        .pipe(Effect.mapError((error) => new RouteRequestError({ message: error.message }))),

    [WS_METHODS.previewReportRecordingMetrics]: (request) =>
      increment(previewRecordingFramesDroppedTotal, {}, request.droppedFrames).pipe(
        Effect.as(undefined),
      ),

    [WS_METHODS.previewRefresh]: (request) =>
      previewManager
        .refresh(withoutTag(request))
        .pipe(Effect.mapError((error) => new RouteRequestError({ message: error.message }))),

    [WS_METHODS.previewClose]: (request) => {
      const body = withoutTag(request);
      return previewManager.close(body).pipe(
        Effect.tap(() => previewAutomationBroker.clearTargets(body.threadId, body.tabId)),
        Effect.mapError((error) => new RouteRequestError({ message: error.message })),
      );
    },

    [WS_METHODS.previewList]: (request) => previewManager.list(withoutTag(request)),

    [WS_METHODS.previewListLocalServers]: (_request, ws) =>
      Effect.gen(function* () {
        const servers = yield* Effect.tryPromise({
          try: () => scanLocalServers(ownedPreviewUrls.urls),
          catch: (cause) =>
            new RouteRequestError({
              message: `Failed to discover local servers: ${String(cause)}`,
            }),
        });
        const result = { servers, scannedAt: new Date().toISOString() };
        yield* pushBus.publishClient(ws, WS_CHANNELS.previewLocalServersUpdated, result);
        return result;
      }),

    [WS_METHODS.previewAutomationReportOwner]: (request, ws) =>
      Effect.gen(function* () {
        const body = withoutTag(request);
        const clientId = getServerPreviewAutomationClientId(ws, body.clientId);
        if (!body.supportsAutomation) {
          yield* previewAutomationBroker.clearOwner(clientId, body.connectionId);
          return {
            clientId: body.clientId,
            connectionId: body.connectionId ?? "preview-disabled",
            leaseExpiresAt: new Date().toISOString(),
          };
        }
        if (body.tabId) {
          const previewList = yield* previewManager.list({ threadId: body.threadId });
          const ownsTab = previewList.sessions.some((session) => session.tabId === body.tabId);
          if (!ownsTab) {
            yield* previewAutomationBroker.clearOwner(clientId, body.connectionId);
            return {
              clientId: body.clientId,
              connectionId: body.connectionId ?? "preview-invalid-tab",
              leaseExpiresAt: new Date().toISOString(),
            };
          }
        }
        return yield* previewAutomationBroker.reportOwner(
          {
            ...body,
            clientId,
            supportsAutomation: true,
            focusedAt: new Date().toISOString(),
          },
          {
            clientId,
            rendererClientId: body.clientId,
            hostId: getPreviewAutomationHostId(ws),
            send: (automationRequest) =>
              pushBus.publishClient(ws, WS_CHANNELS.previewAutomationRequest, automationRequest),
          },
        );
      }),

    [WS_METHODS.previewAutomationClearOwner]: (request, ws) =>
      Effect.gen(function* () {
        const body = withoutTag(request);
        const clientIds = previewAutomationClientIdsByWs.get(ws);
        const serverClientId = clientIds?.get(body.clientId);
        if (serverClientId) {
          yield* previewAutomationBroker.clearOwner(serverClientId, body.connectionId);
          clientIds?.delete(body.clientId);
        }
        return undefined;
      }),

    [HTML_RENDER_WS_METHODS.host]: (request, ws) =>
      Effect.sync(() => {
        if (request.available) {
          htmlPreviewBroker.register(getPreviewAutomationHostId(ws), {
            push: (renderRequest) =>
              pushBus.publishClient(ws, WS_CHANNELS.htmlRenderRequest, renderRequest),
          });
        } else {
          htmlPreviewBroker.unregister(getPreviewAutomationHostId(ws));
        }
        return undefined;
      }),

    [HTML_RENDER_WS_METHODS.respond]: (request, ws) =>
      Effect.sync(() => {
        htmlPreviewBroker.respond(getPreviewAutomationHostId(ws), withoutTag(request));
        return undefined;
      }),

    [WS_METHODS.previewAutomationRespond]: (request, ws) =>
      previewAutomationBroker
        .respond(
          withoutTag(request),
          authorizedPreviewAutomationClientIds(ws),
          previewAutomationHostIdByWs.get(ws),
        )
        .pipe(Effect.as(undefined)),

    [WS_METHODS.previewAutomationSetPaused]: (request) =>
      Effect.gen(function* () {
        const body = withoutTag(request);
        if (!body.paused && Option.isSome(computerAutomationBroker)) {
          const broker = computerAutomationBroker.value;
          yield* Effect.try({
            try: () => broker.assertRemoteResumeAllowed(body.threadId),
            catch: () =>
              new RouteRequestError({
                message: "Resume computer control on the computer running F5.",
              }),
          });
        }
        yield* previewAutomationBroker.setPaused(body.threadId, body.paused);
        if (Option.isSome(computerAutomationBroker)) {
          computerAutomationBroker.value.setPaused(body.threadId, body.paused);
        }
        return undefined;
      }),

    [WS_METHODS.computerChromeRelease]: (request) =>
      Effect.gen(function* () {
        if (Option.isNone(computerAutomationBroker)) {
          return { released: false, outcome: "not-holder" as const };
        }
        const broker = computerAutomationBroker.value;
        // The same path preemption uses: only an idle holder in this profile gives way.
        const outcome = yield* Effect.promise(() =>
          broker.releaseChromeHolderOutcome(request.threadId),
        );
        return { released: outcome === "released", outcome };
      }),

    [WS_METHODS.computerAccessRevoke]: (request) =>
      Effect.sync(() => {
        if (Option.isSome(computerAutomationBroker)) {
          computerAutomationBroker.value.access.revoke(request.threadId, request.appId);
        }
        return undefined;
      }),

    [WS_METHODS.computerAccessList]: (request) =>
      Effect.sync(() =>
        Option.isSome(computerAutomationBroker)
          ? computerAutomationBroker.value.access.grants(request.threadId)
          : [],
      ),

    [WS_METHODS.computerAccessListRemembered]: (request) =>
      Effect.sync(() =>
        Option.isSome(computerAutomationBroker)
          ? computerAutomationBroker.value.access.listRemembered(request.projectId)
          : [],
      ),

    [WS_METHODS.computerAccessForgetRemembered]: (request) =>
      Effect.gen(function* () {
        if (Option.isSome(computerAutomationBroker)) {
          yield* Effect.promise(() =>
            computerAutomationBroker.value.access.forgetRemembered(
              request.projectId,
              request.appId,
            ),
          );
        }
        return undefined;
      }),

    [WS_METHODS.claudeChromeRestoreNativeHost]: (request) =>
      restoreChromeNativeHost("claude", request.transactionId),

    [WS_METHODS.codexChromeRestoreNativeHost]: (request) =>
      restoreChromeNativeHost("codex", request.transactionId),

    [WS_METHODS.chromeNativeHostListTransactions]: (request) =>
      listChromeSessionSetups(stateDir, request.provider).pipe(
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
        Effect.catchDefect(() =>
          Effect.fail(new RouteRequestError({ message: "Chrome transactions could not be read." })),
        ),
      ),

    [WS_METHODS.chromeGetReadiness]: (request) =>
      Effect.gen(function* () {
        const instanceId = ProviderInstanceId.make(request.providerInstanceId);
        const instance = yield* providerInstanceRegistry.getInstance(instanceId);
        const settings = yield* serverSettings.getSettings;
        const checkedAt = new Date().toISOString();
        const provider = instance?.driverKind === "codex" ? "codex" : "claude";
        const enabled =
          provider === "claude" ? settings.enableClaudeInChrome : settings.enableCodexChrome;
        // Disabled instances and settings answer cheaply without touching disk; a closed
        // certification gate is static, so its reason is reported even while off.
        if (!instance?.enabled || !enabled || !instance.adapter.getChromeReadiness) {
          const reason =
            instance && !instance.adapter.getChromeReadiness
              ? "This agent has no provider-native Chrome integration."
              : integrationUnavailableDetail(
                  provider === "claude" ? "claude-chrome" : "codex-chrome",
                  process.platform,
                  process.arch,
                );
          return {
            providerInstanceId: request.providerInstanceId,
            provider,
            eligibility: "off" as const,
            ...(reason ? { reason } : {}),
            checkedAt,
          };
        }
        const readiness = yield* instance.adapter.getChromeReadiness();
        return {
          providerInstanceId: request.providerInstanceId,
          provider,
          checkedAt,
          ...readiness,
        };
      }),
  };
};
