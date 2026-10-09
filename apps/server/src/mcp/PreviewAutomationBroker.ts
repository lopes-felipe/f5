import { AutomationQueue } from "./automationQueue";
import { AgentControlPause, AgentControlPauseService } from "./agentControlPause";
import { type AgentBrowserPolicy, resolveAgentBrowserPolicy } from "./browserAccess";
import { randomUUID } from "node:crypto";

import {
  PreviewAutomationBusyError,
  PreviewAutomationCapacityExceededError,
  PreviewAutomationControlInterruptedError,
  PreviewAutomationExecutionError,
  PreviewAutomationInvalidSelectorError,
  PreviewAutomationNavigationBlockedError,
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
import { Effect, Layer, Option, Schema, ServiceMap } from "effect";

export interface PreviewAutomationInvokeInput {
  readonly threadId: ThreadId;
  readonly automationSessionId?: string;
  readonly operation: PreviewAutomationOperation;
  readonly input: unknown;
  readonly tabId?: PreviewTabId;
  readonly timeoutMs?: number;
  /** Policy the caller already resolved for this call; skips the broker's own lookup. */
  readonly policy?: AgentBrowserPolicy;
}

export interface PreviewAutomationClient {
  readonly clientId: string;
  readonly rendererClientId?: string;
  /** The renderer connection that hosts this owner; used to route owner requests. */
  readonly hostId?: string;
  readonly send: (request: PreviewAutomationRequest) => Effect.Effect<boolean>;
}

export type PreviewAutomationHostEvent =
  | { readonly type: "ownerRequested"; readonly requestId: string; readonly threadId: ThreadId }
  | { readonly type: "ownerReleased"; readonly threadId: ThreadId }
  | { readonly type: "pauseChanged"; readonly threadId: ThreadId; readonly paused: boolean };

/** A renderer connection that can be asked to create preview owners. */
export interface PreviewAutomationHost {
  readonly hostId: string;
  readonly push: (event: PreviewAutomationHostEvent) => Effect.Effect<boolean>;
}

export interface PreviewAutomationBrokerShape {
  /** Live server-owned policy for a thread. Transports resolve it once per tool call. */
  readonly resolvePolicy: (threadId: ThreadId) => Effect.Effect<AgentBrowserPolicy>;
  readonly registerHost: (host: PreviewAutomationHost) => Effect.Effect<void>;
  readonly unregisterHost: (hostId: string) => Effect.Effect<void>;
  readonly reportOwner: (
    owner: PreviewAutomationOwner,
    client: PreviewAutomationClient,
  ) => Effect.Effect<PreviewAutomationRegistration>;
  readonly clearOwner: (clientId: string, connectionId?: string) => Effect.Effect<void>;
  readonly clearTargets: (threadId: ThreadId, tabId?: PreviewTabId) => Effect.Effect<void>;
  readonly respond: (
    response: PreviewAutomationResponse,
    authorizedClientIds: ReadonlySet<string>,
    hostId?: string,
  ) => Effect.Effect<void>;
  readonly invoke: <A = unknown>(
    request: PreviewAutomationInvokeInput,
  ) => Effect.Effect<A, PreviewAutomationBrokerError>;
  readonly setPaused: (threadId: ThreadId, paused: boolean) => Effect.Effect<void>;
  readonly isPaused: (threadId: ThreadId) => Effect.Effect<boolean>;
  /** The agent session for this thread ended: drop bindings and unpin hidden previews. */
  readonly releaseThread: (threadId: ThreadId) => Effect.Effect<void>;
  readonly shutdown: Effect.Effect<void>;
}

export class PreviewAutomationBroker extends ServiceMap.Service<
  PreviewAutomationBroker,
  PreviewAutomationBrokerShape
>()("t3/mcp/PreviewAutomationBroker") {}

export type PreviewAutomationBrokerError =
  | PreviewAutomationBusyError
  | PreviewAutomationCapacityExceededError
  | PreviewAutomationControlInterruptedError
  | PreviewAutomationExecutionError
  | PreviewAutomationInvalidSelectorError
  | PreviewAutomationNavigationBlockedError
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

interface RegisteredHost {
  readonly host: PreviewAutomationHost;
  /** Last time this host reported an automation-capable owner; 0 when never. */
  lastOwnerReportAt: number;
}

interface OwnerRequest {
  readonly requestId: string;
  readonly hostIds: ReadonlySet<string>;
  readonly waiters: Set<OwnerWaiter>;
}

interface OwnerWaiter {
  readonly resolve: () => void;
  readonly reject: (error: PreviewAutomationBrokerError) => void;
}

const PREVIEW_OWNER_LEASE_MS = 30_000;
const PREVIEW_OWNER_SWEEP_MS = 5_000;
const DEFAULT_TIMEOUT_MS = 15_000;
const BROKER_GRACE_MS = 2_000;
export const OWNER_REQUEST_MAX_WAIT_MS = 10_000;
export const MAX_QUEUED_MUTATIONS_PER_THREAD = 32;

const MUTATING_OPERATIONS: ReadonlySet<PreviewAutomationOperation> = new Set([
  "open",
  "navigate",
  "click",
  "type",
  "press",
  "scroll",
  "evaluate",
  "viewport",
  "recordingStart",
  "recordingStop",
]);

export function isMutatingPreviewOperation(operation: PreviewAutomationOperation): boolean {
  return MUTATING_OPERATIONS.has(operation);
}

export const PREVIEW_CONTROL_INTERRUPTED_MESSAGE =
  "The user took control of the browser preview. Ask the user before continuing, then take a fresh preview_snapshot.";

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

const brokerErrorGuards = [
  Schema.is(PreviewAutomationBusyError),
  Schema.is(PreviewAutomationCapacityExceededError),
  Schema.is(PreviewAutomationControlInterruptedError),
  Schema.is(PreviewAutomationExecutionError),
  Schema.is(PreviewAutomationInvalidSelectorError),
  Schema.is(PreviewAutomationNavigationBlockedError),
  Schema.is(PreviewAutomationNoFocusedOwnerError),
  Schema.is(PreviewAutomationResultTooLargeError),
  Schema.is(PreviewAutomationTabNotFoundError),
  Schema.is(PreviewAutomationTimeoutError),
  Schema.is(PreviewAutomationUnavailableError),
];

function isPreviewAutomationError(cause: unknown): cause is PreviewAutomationBrokerError {
  return brokerErrorGuards.some((guard) => guard(cause));
}

function detailRecord(detail: unknown): Record<string, unknown> | undefined {
  return typeof detail === "object" && detail !== null
    ? (detail as Record<string, unknown>)
    : undefined;
}

export function responseErrorToPreviewError(
  error: NonNullable<PreviewAutomationResponse["error"]>,
): PreviewAutomationBrokerError {
  const detail = detailRecord(error.detail);
  switch (error._tag) {
    case "PreviewAutomationInvalidSelectorError":
      return new PreviewAutomationInvalidSelectorError({
        message: error.message,
        selector: typeof detail?.selector === "string" ? detail.selector : "",
      });
    case "PreviewAutomationNoFocusedOwnerError":
      return new PreviewAutomationNoFocusedOwnerError({ message: error.message });
    case "PreviewAutomationResultTooLargeError":
      return new PreviewAutomationResultTooLargeError({
        message: error.message,
        maximumBytes: typeof detail?.maximumBytes === "number" ? detail.maximumBytes : 64_000,
      });
    case "PreviewAutomationTabNotFoundError":
      return new PreviewAutomationTabNotFoundError({ message: error.message });
    case "PreviewAutomationTimeoutError":
      return new PreviewAutomationTimeoutError({ message: error.message });
    case "PreviewAutomationUnavailableError":
      return new PreviewAutomationUnavailableError({ message: error.message });
    case "PreviewAutomationControlInterruptedError":
      return new PreviewAutomationControlInterruptedError({ message: error.message });
    case "PreviewAutomationBusyError":
      return new PreviewAutomationBusyError({ message: error.message });
    case "PreviewAutomationCapacityExceededError":
      return new PreviewAutomationCapacityExceededError({ message: error.message });
    case "PreviewAutomationNavigationBlockedError":
      return new PreviewAutomationNavigationBlockedError({
        message: error.message,
        ...(typeof detail?.host === "string" ? { host: detail.host } : {}),
      });
    default:
      return new PreviewAutomationExecutionError({
        message: error.message,
        detail: error.detail,
      });
  }
}

/** Used only when no resolver is configured (unit tests and bare brokers). */
const UNRESTRICTED_POLICY: AgentBrowserPolicy = {
  previewAutomation: true,
  externalHosts: [],
  claudeInChrome: false,
  computerUse: false,
};

export interface PreviewAutomationBrokerOptions {
  readonly pause?: AgentControlPause;
  /** Live policy lookup used when a caller does not pass one, and after owner waits. */
  readonly resolvePolicy?: (threadId: ThreadId) => Effect.Effect<AgentBrowserPolicy>;
}

export function makePreviewAutomationBroker(
  options: PreviewAutomationBrokerOptions = {},
): PreviewAutomationBrokerShape {
  const owners = new Map<string, LeasedOwner>();
  const pending = new Map<string, PendingRequest>();
  const sessionTargets = new Map<string, { tabId: PreviewTabId; connectionId: string }>();
  /** First owner that served an automation session; never reranked mid-session. */
  const sessionOwners = new Map<string, { clientId: string; connectionId: string }>();
  const hosts = new Map<string, RegisteredHost>();
  const ownerRequests = new Map<ThreadId, OwnerRequest>();
  const mutationQueue = new AutomationQueue<PreviewAutomationBrokerError>({
    capacity: MAX_QUEUED_MUTATIONS_PER_THREAD,
    busy: () =>
      new PreviewAutomationBusyError({
        message: `More than ${MAX_QUEUED_MUTATIONS_PER_THREAD} browser actions are queued for this thread. Wait for them to finish.`,
      }),
    cancelled: () =>
      new PreviewAutomationTimeoutError({ message: "Preview request was cancelled." }),
    expired: () =>
      new PreviewAutomationTimeoutError({
        message: "Preview request timed out waiting for earlier browser actions; it was not run.",
      }),
  });
  const pausedThreads = options.pause ?? new AgentControlPause();
  let shutDown = false;

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

  const pushToHost = (hostId: string, event: PreviewAutomationHostEvent): void => {
    const registered = hosts.get(hostId);
    if (!registered) return;
    void Effect.runPromise(registered.host.push(event)).catch(() => undefined);
  };

  const pushToAllHosts = (event: PreviewAutomationHostEvent): void => {
    for (const hostId of hosts.keys()) pushToHost(hostId, event);
  };

  const settleOwnerRequest = (
    threadId: ThreadId,
    outcome: { readonly error?: PreviewAutomationBrokerError },
  ): void => {
    const request = ownerRequests.get(threadId);
    if (!request) return;
    ownerRequests.delete(threadId);
    for (const waiter of request.waiters) {
      if (outcome.error) waiter.reject(outcome.error);
      else waiter.resolve();
    }
  };

  /**
   * Ask a desktop renderer to create an owner for `threadId`. Goes to the most
   * recently active desktop host, or to every host when none has reported an
   * owner since server start. Concurrent requests for a thread share one push.
   */
  const awaitOwner = (threadId: ThreadId, waitMs: number): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      if (shutDown) {
        reject(new PreviewAutomationUnavailableError({ message: "F5 is shutting down." }));
        return;
      }
      let request = ownerRequests.get(threadId);
      if (!request) {
        const active = [...hosts.values()]
          .filter((entry) => entry.lastOwnerReportAt > 0)
          .sort((left, right) => right.lastOwnerReportAt - left.lastOwnerReportAt)[0];
        const hostIds = new Set(active ? [active.host.hostId] : hosts.keys());
        if (hostIds.size === 0) {
          reject(
            new PreviewAutomationNoFocusedOwnerError({
              message: "No F5 desktop window is connected to host the browser preview.",
            }),
          );
          return;
        }
        request = { requestId: `preview-owner-${randomUUID()}`, hostIds, waiters: new Set() };
        ownerRequests.set(threadId, request);
        for (const hostId of hostIds) {
          pushToHost(hostId, { type: "ownerRequested", requestId: request.requestId, threadId });
        }
      }
      const activeRequest = request;
      const waiter: OwnerWaiter = {
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      };
      const timer = setTimeout(() => {
        activeRequest.waiters.delete(waiter);
        if (activeRequest.waiters.size === 0 && ownerRequests.get(threadId) === activeRequest) {
          ownerRequests.delete(threadId);
        }
        reject(
          new PreviewAutomationNoFocusedOwnerError({
            message: `The desktop app did not open a browser preview within ${waitMs}ms.`,
          }),
        );
      }, waitMs);
      activeRequest.waiters.add(waiter);
    });

  const selectOwner = (
    input: PreviewAutomationInvokeInput,
    sessionKey: string | null,
  ): LeasedOwner | PreviewAutomationBrokerError => {
    sweepExpiredOwners();
    const capability = requiredCapability(input.operation);
    const supports = (leased: LeasedOwner) =>
      leased.owner.threadId === input.threadId &&
      leased.owner.supportsAutomation &&
      (leased.owner.capabilities ?? ["automation"]).includes(capability);
    const bound = sessionKey ? sessionOwners.get(sessionKey) : undefined;
    if (bound) {
      const leased = owners.get(bound.clientId);
      if (leased && leased.connectionId === bound.connectionId && supports(leased)) return leased;
      if (leased && leased.connectionId === bound.connectionId) {
        return new PreviewAutomationUnavailableError({
          message: `The browser preview controlled by this session does not support ${capability}.`,
        });
      }
      // The bound owner is gone. Only preview_open may re-request a new one.
      if (input.operation !== "open") {
        return new PreviewAutomationNoFocusedOwnerError({
          message:
            "The browser preview this agent session was using closed. Call preview_open to reopen it.",
        });
      }
      sessionOwners.delete(sessionKey!);
    }
    const candidates = Array.from(owners.values())
      .filter(supports)
      .sort(
        (left, right) =>
          Number(right.owner.visible) - Number(left.owner.visible) ||
          right.owner.focusedAt.localeCompare(left.owner.focusedAt),
      );
    return (
      candidates[0] ??
      new PreviewAutomationNoFocusedOwnerError({
        message: "No desktop browser preview is available for this thread.",
      })
    );
  };

  const acquireThreadSlot = (threadId: ThreadId, signal: AbortSignal, deadlineMs: number) =>
    mutationQueue.acquire(threadId, signal, deadlineMs);
  const failQueuedMutations = (threadId: ThreadId, error: PreviewAutomationBrokerError) =>
    mutationQueue.flush(threadId, error);

  const resolveThreadPolicy = (threadId: ThreadId): Effect.Effect<AgentBrowserPolicy> =>
    options.resolvePolicy ? options.resolvePolicy(threadId) : Effect.succeed(UNRESTRICTED_POLICY);

  const resolvePolicy = (input: PreviewAutomationInvokeInput) =>
    input.policy ? Effect.succeed(input.policy) : resolveThreadPolicy(input.threadId);

  const dispatch = <A>(
    input: PreviewAutomationInvokeInput,
    leased: LeasedOwner,
    sessionKey: string | null,
    timeoutMs: number,
  ): Promise<A> =>
    new Promise<A>((resolve, reject) => {
      const { owner, client } = leased;
      if (sessionKey && !sessionOwners.has(sessionKey)) {
        sessionOwners.set(sessionKey, {
          clientId: client.clientId,
          connectionId: leased.connectionId,
        });
      }
      const mappedTarget = sessionKey ? sessionTargets.get(sessionKey) : undefined;
      const mappedTabId =
        mappedTarget?.connectionId === leased.connectionId ? mappedTarget.tabId : undefined;
      const targetTabId = input.tabId ?? mappedTabId ?? owner.tabId ?? undefined;
      if (sessionKey && input.tabId) {
        sessionTargets.set(sessionKey, { tabId: input.tabId, connectionId: leased.connectionId });
      }

      if (input.operation !== "open" && input.operation !== "status" && !targetTabId) {
        reject(
          new PreviewAutomationTabNotFoundError({
            message: "The browser preview does not have an active tab.",
          }),
        );
        return;
      }

      const brokerTimeoutMs = timeoutMs + BROKER_GRACE_MS;
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
    });

  const withPausedFlag = (threadId: ThreadId, value: unknown): unknown => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return value;
    return pausedThreads.has(threadId) ? { ...value, paused: true, reason: "paused" } : value;
  };

  const disabledError = () =>
    new PreviewAutomationUnavailableError({
      message: "Agent browser access is disabled for this project.",
      reason: "disabled",
    });

  const interruptedError = () =>
    new PreviewAutomationControlInterruptedError({ message: PREVIEW_CONTROL_INTERRUPTED_MESSAGE });

  const offPause = pausedThreads.subscribe((id, paused) => {
    const threadId = id as ThreadId;
    if (paused) failQueuedMutations(threadId, interruptedError());
    pushToAllHosts({ type: "pauseChanged", threadId, paused });
  });
  return {
    resolvePolicy: resolveThreadPolicy,

    registerHost: (host) =>
      Effect.sync(() => {
        const existing = hosts.get(host.hostId);
        hosts.set(host.hostId, { host, lastOwnerReportAt: existing?.lastOwnerReportAt ?? 0 });
      }),

    unregisterHost: (hostId) =>
      Effect.sync(() => {
        hosts.delete(hostId);
      }),

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
        if (client.hostId) {
          const registered = hosts.get(client.hostId);
          if (registered) registered.lastOwnerReportAt = Date.now();
        }
        if (owner.supportsAutomation) settleOwnerRequest(owner.threadId, {});
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

    respond: (response, authorizedClientIds, hostId) =>
      Effect.sync(() => {
        // A renderer that cannot satisfy an owner request answers with its request id.
        for (const [threadId, request] of ownerRequests) {
          if (request.requestId !== response.requestId) continue;
          if (!hostId || !request.hostIds.has(hostId) || response.ok) return;
          settleOwnerRequest(threadId, {
            error: response.error
              ? responseErrorToPreviewError(response.error)
              : new PreviewAutomationNoFocusedOwnerError({
                  message: "The desktop app could not open a browser preview.",
                }),
          });
          return;
        }
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
      Effect.gen(function* () {
        const policy = yield* resolvePolicy(input);
        if (!policy.previewAutomation) return yield* disabledError();
        const mutating = isMutatingPreviewOperation(input.operation);
        if (mutating && pausedThreads.has(input.threadId)) return yield* interruptedError();
        const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
        const sessionKey = input.automationSessionId
          ? `${input.threadId}\u0000${input.automationSessionId}`
          : null;
        const startedAt = Date.now();

        const result = yield* Effect.tryPromise({
          try: async (signal) => {
            const slot = mutating
              ? await acquireThreadSlot(input.threadId, signal, timeoutMs)
              : { release: () => undefined, waited: false };
            const release = slot.release;
            try {
              if (mutating && pausedThreads.has(input.threadId)) throw interruptedError();
              if (slot.waited) {
                // Access may have been turned off while this action waited its turn.
                const refreshed = await Effect.runPromise(resolveThreadPolicy(input.threadId));
                if (!refreshed.previewAutomation) throw disabledError();
              }
              let selected = selectOwner(input, sessionKey);
              if (
                input.operation === "open" &&
                Schema.is(PreviewAutomationNoFocusedOwnerError)(selected)
              ) {
                const remaining = timeoutMs - (Date.now() - startedAt);
                await awaitOwner(
                  input.threadId,
                  Math.max(0, Math.min(OWNER_REQUEST_MAX_WAIT_MS, remaining)),
                );
                // Settings may have changed while the desktop app opened the preview.
                const refreshed = await Effect.runPromise(resolveThreadPolicy(input.threadId));
                if (!refreshed.previewAutomation) throw disabledError();
                if (pausedThreads.has(input.threadId)) throw interruptedError();
                selected = selectOwner(input, sessionKey);
              }
              if (isPreviewAutomationError(selected)) throw selected;
              const remaining = timeoutMs - (Date.now() - startedAt);
              if (remaining <= 0) {
                // The caller has already given up; never start an action past its deadline.
                throw new PreviewAutomationTimeoutError({
                  message: "Preview request timed out before it could run; it was not run.",
                });
              }
              return await dispatch<A>(input, selected, sessionKey, remaining);
            } finally {
              release();
            }
          },
          catch: (cause) =>
            isPreviewAutomationError(cause)
              ? cause
              : new PreviewAutomationExecutionError({
                  message: cause instanceof Error ? cause.message : String(cause),
                  detail: cause,
                }),
        });
        return (input.operation === "status"
          ? withPausedFlag(input.threadId, result)
          : result) as unknown as A;
      }) as Effect.Effect<A, PreviewAutomationBrokerError>,

    setPaused: (threadId, paused) =>
      Effect.sync(() => {
        pausedThreads.set(threadId, paused);
        if (paused) failQueuedMutations(threadId, interruptedError());
      }),

    isPaused: (threadId) => Effect.sync(() => pausedThreads.has(threadId)),

    releaseThread: (threadId) =>
      Effect.sync(() => {
        const prefix = `${threadId}\u0000`;
        // Deleting the current key while iterating a Map is safe.
        for (const key of sessionOwners.keys()) {
          if (key.startsWith(prefix)) sessionOwners.delete(key);
        }
        for (const key of sessionTargets.keys()) {
          if (key.startsWith(prefix)) sessionTargets.delete(key);
        }
        settleOwnerRequest(threadId, {
          error: new PreviewAutomationUnavailableError({
            message: "The agent session for this thread ended.",
          }),
        });
        pushToAllHosts({ type: "ownerReleased", threadId });
      }),

    shutdown: Effect.sync(() => {
      shutDown = true;
      clearInterval(sweepTimer);
      offPause();
      const error = new PreviewAutomationUnavailableError({ message: "F5 is shutting down." });
      for (const threadId of ownerRequests.keys()) settleOwnerRequest(threadId, { error });
      mutationQueue.flushAll(error);
    }),
  };
}

export const PreviewAutomationBrokerLive = Layer.effect(
  PreviewAutomationBroker,
  Effect.gen(function* () {
    const services = yield* Effect.services<never>();
    const pause = yield* Effect.serviceOption(AgentControlPauseService);
    const broker = makePreviewAutomationBroker({
      ...(Option.isSome(pause) ? { pause: pause.value } : {}),
      resolvePolicy: (thread) => resolveAgentBrowserPolicy(thread).pipe(Effect.provide(services)),
    });
    yield* Effect.addFinalizer(() => broker.shutdown);
    return broker;
  }),
);
