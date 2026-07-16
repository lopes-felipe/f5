import { randomUUID } from "node:crypto";

import {
  PreviewAutomationExecutionError,
  PreviewAutomationInvalidSelectorError,
  PreviewAutomationNoFocusedOwnerError,
  type PreviewAutomationOperation,
  type PreviewAutomationOwner,
  type PreviewAutomationRegistration,
  type PreviewAutomationRequest,
  type PreviewAutomationResponse,
  PreviewAutomationResultTooLargeError,
  PreviewAutomationTabNotFoundError,
  PreviewAutomationTimeoutError,
  PreviewAutomationUnavailableError,
  type PreviewTabId,
  type PreviewHostCapability,
  type ThreadId,
} from "@t3tools/contracts";
import { Effect, Layer, Schema, ServiceMap } from "effect";

export interface PreviewAutomationInvokeInput {
  readonly threadId: ThreadId;
  readonly automationSessionId?: string;
  readonly operation: PreviewAutomationOperation;
  readonly input: unknown;
  readonly tabId?: PreviewTabId;
  readonly timeoutMs?: number;
}

export interface PreviewAutomationClient {
  readonly clientId: string;
  readonly rendererClientId?: string;
  readonly send: (request: PreviewAutomationRequest) => Effect.Effect<boolean>;
}

export interface PreviewAutomationBrokerShape {
  readonly reportOwner: (
    owner: PreviewAutomationOwner,
    client: PreviewAutomationClient,
  ) => Effect.Effect<PreviewAutomationRegistration>;
  readonly clearOwner: (clientId: string, connectionId?: string) => Effect.Effect<void>;
  readonly clearTargets: (threadId: ThreadId, tabId?: PreviewTabId) => Effect.Effect<void>;
  readonly respond: (
    response: PreviewAutomationResponse,
    authorizedClientIds: ReadonlySet<string>,
  ) => Effect.Effect<void>;
  readonly invoke: <A = unknown>(
    request: PreviewAutomationInvokeInput,
  ) => Effect.Effect<A, PreviewAutomationBrokerError>;
}

export class PreviewAutomationBroker extends ServiceMap.Service<
  PreviewAutomationBroker,
  PreviewAutomationBrokerShape
>()("t3/mcp/PreviewAutomationBroker") {}

export type PreviewAutomationBrokerError =
  | PreviewAutomationExecutionError
  | PreviewAutomationInvalidSelectorError
  | PreviewAutomationNoFocusedOwnerError
  | PreviewAutomationResultTooLargeError
  | PreviewAutomationTabNotFoundError
  | PreviewAutomationTimeoutError
  | PreviewAutomationUnavailableError;

interface PendingRequest {
  readonly clientId: string;
  readonly rendererClientId: string;
  readonly connectionId: string;
  readonly timeout: ReturnType<typeof setTimeout>;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: PreviewAutomationBrokerError) => void;
}

interface LeasedOwner {
  readonly owner: PreviewAutomationOwner;
  readonly client: PreviewAutomationClient;
  readonly rendererClientId: string;
  readonly connectionId: string;
  readonly leaseExpiresAtMs: number;
}

const PREVIEW_OWNER_LEASE_MS = 30_000;
const PREVIEW_OWNER_SWEEP_MS = 5_000;

function requiredCapability(operation: PreviewAutomationOperation): PreviewHostCapability {
  switch (operation) {
    case "viewport":
      return "viewport";
    case "screenshot":
      return "screenshot";
    case "recordingStart":
    case "recordingStop":
      return "recording";
    default:
      return "automation";
  }
}

function isPreviewAutomationError(cause: unknown): cause is PreviewAutomationBrokerError {
  const isExecutionError = Schema.is(PreviewAutomationExecutionError);
  const isInvalidSelectorError = Schema.is(PreviewAutomationInvalidSelectorError);
  const isNoFocusedOwnerError = Schema.is(PreviewAutomationNoFocusedOwnerError);
  const isResultTooLargeError = Schema.is(PreviewAutomationResultTooLargeError);
  const isTabNotFoundError = Schema.is(PreviewAutomationTabNotFoundError);
  const isTimeoutError = Schema.is(PreviewAutomationTimeoutError);
  const isUnavailableError = Schema.is(PreviewAutomationUnavailableError);
  return (
    isExecutionError(cause) ||
    isInvalidSelectorError(cause) ||
    isNoFocusedOwnerError(cause) ||
    isResultTooLargeError(cause) ||
    isTabNotFoundError(cause) ||
    isTimeoutError(cause) ||
    isUnavailableError(cause)
  );
}

function responseErrorToPreviewError(
  error: NonNullable<PreviewAutomationResponse["error"]>,
): PreviewAutomationBrokerError {
  switch (error._tag) {
    case "PreviewAutomationInvalidSelectorError": {
      const detail =
        typeof error.detail === "object" && error.detail !== null ? error.detail : undefined;
      return new PreviewAutomationInvalidSelectorError({
        message: error.message,
        selector:
          detail && "selector" in detail && typeof detail.selector === "string"
            ? detail.selector
            : "",
      });
    }
    case "PreviewAutomationNoFocusedOwnerError":
      return new PreviewAutomationNoFocusedOwnerError({ message: error.message });
    case "PreviewAutomationResultTooLargeError": {
      const detail =
        typeof error.detail === "object" && error.detail !== null ? error.detail : undefined;
      return new PreviewAutomationResultTooLargeError({
        message: error.message,
        maximumBytes:
          detail && "maximumBytes" in detail && typeof detail.maximumBytes === "number"
            ? detail.maximumBytes
            : 64_000,
      });
    }
    case "PreviewAutomationTabNotFoundError":
      return new PreviewAutomationTabNotFoundError({ message: error.message });
    case "PreviewAutomationTimeoutError":
      return new PreviewAutomationTimeoutError({ message: error.message });
    case "PreviewAutomationUnavailableError":
      return new PreviewAutomationUnavailableError({ message: error.message });
    default:
      return new PreviewAutomationExecutionError({
        message: error.message,
        detail: error.detail,
      });
  }
}

export function makePreviewAutomationBroker(): PreviewAutomationBrokerShape {
  const owners = new Map<string, LeasedOwner>();
  const pending = new Map<string, PendingRequest>();
  const sessionTargets = new Map<string, { tabId: PreviewTabId; connectionId: string }>();

  const removePending = (requestId: string): PendingRequest | undefined => {
    const entry = pending.get(requestId);
    if (!entry) return undefined;
    pending.delete(requestId);
    clearTimeout(entry.timeout);
    return entry;
  };

  const failPendingForClient = (clientId: string, error: PreviewAutomationBrokerError): void => {
    for (const [requestId, entry] of pending) {
      if (entry.clientId !== clientId) continue;
      pending.delete(requestId);
      clearTimeout(entry.timeout);
      entry.reject(error);
    }
  };

  const clearSessionTargetsForConnection = (connectionId: string): void => {
    for (const [key, target] of sessionTargets) {
      if (target.connectionId === connectionId) sessionTargets.delete(key);
    }
  };

  const clearLeasedOwner = (clientId: string, connectionId?: string): void => {
    const leased = owners.get(clientId);
    if (!leased || (connectionId !== undefined && leased.connectionId !== connectionId)) return;
    owners.delete(clientId);
    clearSessionTargetsForConnection(leased.connectionId);
    failPendingForClient(
      clientId,
      new PreviewAutomationUnavailableError({
        message: "The preview automation client disconnected.",
      }),
    );
  };

  const sweepExpiredOwners = (): void => {
    const now = Date.now();
    for (const [clientId, leased] of owners) {
      if (leased.leaseExpiresAtMs > now) continue;
      clearLeasedOwner(clientId, leased.connectionId);
    }
  };
  const sweepTimer = setInterval(sweepExpiredOwners, PREVIEW_OWNER_SWEEP_MS);
  sweepTimer.unref?.();

  return {
    reportOwner: (owner, client) =>
      Effect.sync(() => {
        sweepExpiredOwners();
        const previous = owners.get(client.clientId);
        const canRenew =
          owner.connectionId !== undefined && previous?.connectionId === owner.connectionId;
        const connectionId = canRenew
          ? previous.connectionId
          : `preview-connection-${randomUUID()}`;
        if (previous && previous.connectionId !== connectionId) {
          clearSessionTargetsForConnection(previous.connectionId);
          failPendingForClient(
            client.clientId,
            new PreviewAutomationUnavailableError({
              message: "The preview automation host connection was replaced.",
            }),
          );
        }
        const rendererClientId = client.rendererClientId ?? owner.clientId;
        const leaseExpiresAtMs = Date.now() + PREVIEW_OWNER_LEASE_MS;
        owners.set(client.clientId, {
          owner: { ...owner, connectionId },
          client,
          rendererClientId,
          connectionId,
          leaseExpiresAtMs,
        });
        return {
          clientId: rendererClientId,
          connectionId,
          leaseExpiresAt: new Date(leaseExpiresAtMs).toISOString(),
        };
      }),

    clearOwner: (clientId, connectionId) =>
      Effect.sync(() => {
        clearLeasedOwner(clientId, connectionId);
      }),

    clearTargets: (threadId, tabId) =>
      Effect.sync(() => {
        const prefix = `${threadId}\u0000`;
        for (const [key, target] of sessionTargets) {
          if (key.startsWith(prefix) && (tabId === undefined || target.tabId === tabId)) {
            sessionTargets.delete(key);
          }
        }
      }),

    respond: (response, authorizedClientIds) =>
      Effect.sync(() => {
        const pendingEntry = pending.get(response.requestId);
        if (
          !pendingEntry ||
          !authorizedClientIds.has(pendingEntry.clientId) ||
          response.clientId !== pendingEntry.rendererClientId ||
          response.connectionId !== pendingEntry.connectionId
        ) {
          return;
        }
        const entry = removePending(response.requestId);
        if (!entry) return;
        if (response.ok) {
          entry.resolve(response.result);
          return;
        }
        entry.reject(
          response.error
            ? responseErrorToPreviewError(response.error)
            : new PreviewAutomationExecutionError({
                message: "Preview automation failed without an error payload.",
              }),
        );
      }),

    invoke: <A = unknown>(input: PreviewAutomationInvokeInput) =>
      Effect.tryPromise({
        try: () =>
          new Promise<A>((resolve, reject) => {
            sweepExpiredOwners();
            const capability = requiredCapability(input.operation);
            const candidates = Array.from(owners.values())
              .filter(
                (leased) =>
                  leased.owner.threadId === input.threadId &&
                  leased.owner.supportsAutomation &&
                  (leased.owner.capabilities ?? ["automation"]).includes(capability),
              )
              .sort(
                (left, right) =>
                  Number(right.owner.visible) - Number(left.owner.visible) ||
                  right.owner.focusedAt.localeCompare(left.owner.focusedAt),
              );
            const leased = candidates[0];
            if (!leased) {
              reject(
                new PreviewAutomationNoFocusedOwnerError({
                  message: "No desktop browser preview is available for this thread.",
                }),
              );
              return;
            }

            const { owner, client } = leased;
            const sessionKey = input.automationSessionId
              ? `${input.threadId}\u0000${input.automationSessionId}`
              : null;
            const mappedTarget = sessionKey ? sessionTargets.get(sessionKey) : undefined;
            const mappedTabId =
              mappedTarget?.connectionId === leased.connectionId ? mappedTarget.tabId : undefined;
            const targetTabId = input.tabId ?? mappedTabId ?? owner.tabId ?? undefined;
            if (sessionKey && input.tabId) {
              sessionTargets.set(sessionKey, {
                tabId: input.tabId,
                connectionId: leased.connectionId,
              });
            }

            if (input.operation !== "open" && input.operation !== "status" && !targetTabId) {
              reject(
                new PreviewAutomationTabNotFoundError({
                  message: "The browser preview does not have an active tab.",
                }),
              );
              return;
            }

            const timeoutMs = input.timeoutMs ?? 15_000;
            const brokerTimeoutMs = timeoutMs + 2_000;
            const requestId = `preview-${randomUUID()}`;
            const timeout = setTimeout(() => {
              const entry = removePending(requestId);
              entry?.reject(
                new PreviewAutomationTimeoutError({
                  message: `Preview automation response timed out after ${brokerTimeoutMs}ms.`,
                }),
              );
            }, brokerTimeoutMs);

            pending.set(requestId, {
              clientId: client.clientId,
              rendererClientId: leased.rendererClientId,
              connectionId: leased.connectionId,
              timeout,
              resolve: (value) => {
                if (
                  sessionKey &&
                  value &&
                  typeof value === "object" &&
                  "tabId" in value &&
                  typeof value.tabId === "string" &&
                  value.tabId.length > 0
                ) {
                  sessionTargets.set(sessionKey, {
                    tabId: value.tabId as PreviewTabId,
                    connectionId: leased.connectionId,
                  });
                }
                resolve(value as A);
              },
              reject,
            });

            void Effect.runPromise(
              client.send({
                requestId,
                clientId: leased.rendererClientId,
                connectionId: leased.connectionId,
                threadId: input.threadId,
                ...(targetTabId ? { tabId: targetTabId } : {}),
                operation: input.operation,
                input: input.input,
                timeoutMs,
              }),
            ).then(
              (delivered) => {
                if (delivered) return;
                const entry = removePending(requestId);
                entry?.reject(
                  new PreviewAutomationUnavailableError({
                    message: "The preview automation client is no longer connected.",
                  }),
                );
              },
              (cause) => {
                const entry = removePending(requestId);
                entry?.reject(
                  new PreviewAutomationUnavailableError({
                    message:
                      cause instanceof Error
                        ? cause.message
                        : "Failed to send preview automation request.",
                  }),
                );
              },
            );
          }),
        catch: (cause) =>
          isPreviewAutomationError(cause)
            ? cause
            : new PreviewAutomationExecutionError({
                message: cause instanceof Error ? cause.message : String(cause),
                detail: cause,
              }),
      }) as Effect.Effect<A, PreviewAutomationBrokerError>,
  };
}

export const PreviewAutomationBrokerLive = Layer.effect(
  PreviewAutomationBroker,
  Effect.sync(makePreviewAutomationBroker),
);
