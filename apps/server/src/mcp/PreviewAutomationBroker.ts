import { randomUUID } from "node:crypto";

import {
  PreviewAutomationExecutionError,
  PreviewAutomationInvalidSelectorError,
  PreviewAutomationNoFocusedOwnerError,
  type PreviewAutomationOperation,
  type PreviewAutomationOwner,
  type PreviewAutomationRequest,
  type PreviewAutomationResponse,
  PreviewAutomationResultTooLargeError,
  PreviewAutomationTabNotFoundError,
  PreviewAutomationTimeoutError,
  PreviewAutomationUnavailableError,
  type PreviewTabId,
  type ThreadId,
} from "@t3tools/contracts";
import { Effect, Layer, Schema, ServiceMap } from "effect";

export interface PreviewAutomationInvokeInput {
  readonly threadId: ThreadId;
  readonly operation: PreviewAutomationOperation;
  readonly input: unknown;
  readonly tabId?: PreviewTabId;
  readonly timeoutMs?: number;
}

export interface PreviewAutomationClient {
  readonly clientId: string;
  readonly send: (request: PreviewAutomationRequest) => Effect.Effect<boolean>;
}

export interface PreviewAutomationBrokerShape {
  readonly reportOwner: (
    owner: PreviewAutomationOwner,
    client: PreviewAutomationClient,
  ) => Effect.Effect<void>;
  readonly clearOwner: (clientId: string) => Effect.Effect<void>;
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
  readonly timeout: ReturnType<typeof setTimeout>;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: PreviewAutomationBrokerError) => void;
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
  const clients = new Map<string, PreviewAutomationClient>();
  const owners = new Map<string, PreviewAutomationOwner>();
  const pending = new Map<string, PendingRequest>();

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

  return {
    reportOwner: (owner, client) =>
      Effect.sync(() => {
        clients.set(client.clientId, client);
        owners.set(owner.clientId, owner);
      }),

    clearOwner: (clientId) =>
      Effect.sync(() => {
        clients.delete(clientId);
        owners.delete(clientId);
        failPendingForClient(
          clientId,
          new PreviewAutomationUnavailableError({
            message: "The preview automation client disconnected.",
          }),
        );
      }),

    respond: (response, authorizedClientIds) =>
      Effect.sync(() => {
        const pendingEntry = pending.get(response.requestId);
        if (!pendingEntry || !authorizedClientIds.has(pendingEntry.clientId)) {
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
            const candidates = Array.from(owners.values())
              .filter(
                (owner) =>
                  owner.threadId === input.threadId &&
                  owner.supportsAutomation &&
                  clients.has(owner.clientId),
              )
              .sort((left, right) => right.focusedAt.localeCompare(left.focusedAt));
            const owner = candidates[0];
            if (!owner) {
              reject(
                new PreviewAutomationNoFocusedOwnerError({
                  message: "No desktop browser preview is available for this thread.",
                }),
              );
              return;
            }

            const client = clients.get(owner.clientId);
            if (!client) {
              reject(
                new PreviewAutomationUnavailableError({
                  message: "The browser preview host is not connected.",
                }),
              );
              return;
            }

            if (
              input.operation !== "open" &&
              input.operation !== "status" &&
              !owner.tabId &&
              !input.tabId
            ) {
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
              clientId: owner.clientId,
              timeout,
              resolve: (value) => resolve(value as A),
              reject,
            });

            void Effect.runPromise(
              client.send({
                requestId,
                threadId: input.threadId,
                ...((input.tabId ?? owner.tabId) ? { tabId: input.tabId ?? owner.tabId! } : {}),
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
