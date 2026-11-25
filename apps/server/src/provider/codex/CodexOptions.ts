import type {
  ModelCapabilities,
  ModelSelection,
  ProviderInstanceId,
  ProviderModelOptions,
  ProviderStartOptions,
  ThreadId,
} from "@t3tools/contracts";
import {
  getModelSelectionStringOptionValue,
  getProviderOptionBooleanSelectionValue,
} from "@t3tools/shared/model";
import type { ServiceMap } from "effect";

import type { CodexAppServerManager } from "../../codexAppServerManager.ts";
import type { ComputerAutomationBrokerRuntime } from "../../computer/ComputerAutomationBroker";
import type { PreviewMcpHttpServerShape } from "../../mcp/PreviewMcpHttpServer.ts";
import { detectCodexUsageLimit } from "../codexErrors.ts";
import {
  ProviderAdapterRequestError,
  ProviderAdapterSessionClosedError,
  ProviderAdapterSessionNotFoundError,
  type ProviderAdapterError,
} from "../Errors.ts";
import type { EventNdjsonLogger } from "../Layers/EventNdjsonLogger.ts";
import type { NotificationAdmissionLimits } from "../notificationAdmission.ts";

function asObject(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

export const PROVIDER = "codex" as const;

export function codexServiceTierOptions(
  fastMode: boolean | undefined,
  inheritedFastMode = false,
): { readonly serviceTier?: "fast" | "default" } {
  return fastMode === true
    ? { serviceTier: "fast" }
    : fastMode === false && inheritedFastMode
      ? { serviceTier: "default" }
      : {};
}

/**
 * A selection bound to this instance is authoritative: an option it omits is
 * off/default, never a stale `modelOptions` value (same precedence as Claude).
 * Selections for another instance fall back to `modelOptions.codex`.
 */
export function resolveCodexSelectionOptions(input: {
  readonly modelOptions?: ProviderModelOptions | undefined;
  readonly modelSelection?: ModelSelection | undefined;
  readonly boundInstanceId: ProviderInstanceId;
}): {
  readonly reasoningEffort?: string;
  readonly fastMode?: boolean;
  readonly cyberAccessProgram?: "standard" | "daybreakBlue" | "daybreakRed";
} {
  if (input.modelSelection && input.modelSelection.instanceId === input.boundInstanceId) {
    const reasoningEffort = getModelSelectionStringOptionValue(
      input.modelSelection,
      "reasoningEffort",
    );
    const fastMode = getProviderOptionBooleanSelectionValue(
      input.modelSelection.options,
      "fastMode",
    );
    const program = getModelSelectionStringOptionValue(input.modelSelection, "cyberAccessProgram");
    const cyberAccessProgram =
      program === "standard" || program === "daybreakBlue" || program === "daybreakRed"
        ? program
        : undefined;
    return {
      ...(cyberAccessProgram ? { cyberAccessProgram } : {}),
      ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
      ...(fastMode !== undefined ? { fastMode } : {}),
    };
  }
  const codex = input.modelOptions?.codex;
  return {
    ...(codex?.cyberAccessProgram ? { cyberAccessProgram: codex.cyberAccessProgram } : {}),
    ...(codex?.reasoningEffort !== undefined ? { reasoningEffort: codex.reasoningEffort } : {}),
    ...(codex?.fastMode !== undefined ? { fastMode: codex.fastMode } : {}),
  };
}

export interface CodexAdapterLiveOptions {
  readonly getEffectiveModelCapabilities?: () => ReadonlyMap<string, ModelCapabilities>;
  readonly manager?: CodexAppServerManager;
  readonly notificationLimits?: NotificationAdmissionLimits;
  readonly makeManager?: (services?: ServiceMap.ServiceMap<never>) => CodexAppServerManager;
  readonly nativeEventLogPath?: string;
  readonly nativeEventLogger?: EventNdjsonLogger;
  /**
   * Installed in every interactive desktop session; the broker checks live
   * browser policy on each tool call, so settings apply without a restart.
   */
  readonly previewMcpHttpServer?: PreviewMcpHttpServerShape;
  readonly computerAutomationBroker?: ComputerAutomationBrokerRuntime;
  readonly defaultProviderOptions?: ProviderStartOptions;
  readonly processEnvironment?: NodeJS.ProcessEnv;
  /** The provider instance this adapter serves; defaults to `codex`. */
  readonly instanceId?: ProviderInstanceId;
}

export function mergeCodexProviderOptions(
  defaults: ProviderStartOptions | undefined,
  explicit: ProviderStartOptions | undefined,
): ProviderStartOptions | undefined {
  const defaultCodex = defaults?.codex;
  const explicitCodex = explicit?.codex;
  const launchArgs = [...(defaultCodex?.launchArgs ?? []), ...(explicitCodex?.launchArgs ?? [])];
  const codex =
    defaultCodex || explicitCodex || launchArgs.length > 0
      ? {
          ...defaultCodex,
          ...explicitCodex,
          ...(launchArgs.length > 0 ? { launchArgs } : {}),
        }
      : undefined;
  if (!codex && !explicit?.mcpServers && !defaults?.mcpServers) {
    return undefined;
  }
  return {
    ...(defaults?.mcpServers ? { mcpServers: defaults.mcpServers } : {}),
    ...(explicit?.mcpServers ? { mcpServers: explicit.mcpServers } : {}),
    ...(codex ? { codex } : {}),
  };
}

export function toMessage(cause: unknown, fallback: string): string {
  if (cause instanceof Error && cause.message.length > 0) {
    return cause.message;
  }
  return fallback;
}

export function toSessionError(
  threadId: ThreadId,
  cause: unknown,
): ProviderAdapterSessionNotFoundError | ProviderAdapterSessionClosedError | undefined {
  const normalized = toMessage(cause, "").toLowerCase();
  if (normalized.includes("unknown session") || normalized.includes("unknown provider session")) {
    return new ProviderAdapterSessionNotFoundError({
      provider: PROVIDER,
      threadId,
      cause,
    });
  }
  if (
    normalized.includes("session is closed") ||
    (asObject(cause)?.code === -32600 &&
      asObject(asObject(cause)?.data)?.reason === "serverShuttingDown")
  ) {
    return new ProviderAdapterSessionClosedError({
      provider: PROVIDER,
      threadId,
      cause,
    });
  }
  return undefined;
}

export function toRequestError(
  threadId: ThreadId,
  method: string,
  cause: unknown,
): ProviderAdapterError {
  const sessionError = toSessionError(threadId, cause);
  if (sessionError) {
    return sessionError;
  }
  return new ProviderAdapterRequestError({
    provider: PROVIDER,
    method,
    detail: toMessage(cause, `${method} failed`),
    ...(asObject(cause)?.deliveryCertainty === "not_sent" ||
    asObject(cause)?.deliveryCertainty === "unknown"
      ? {
          deliveryCertainty: asObject(cause)!.deliveryCertainty as "not_sent" | "unknown",
          deliveryRetryable: asObject(cause)?.deliveryRetryable === true,
        }
      : {}),
    ...(method === "turn/start"
      ? (() => {
          const usageLimit = detectCodexUsageLimit({
            message: toMessage(cause, ""),
            errorInfo: asObject(asObject(cause)?.data)?.codexErrorInfo,
            at: new Date().toISOString(),
          });
          return usageLimit ? { usageLimit } : {};
        })()
      : {}),
    cause,
  });
}
