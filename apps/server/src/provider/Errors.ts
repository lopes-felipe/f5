import {
  ProviderSessionAction,
  ProviderSessionUnavailableReason,
  RuntimeUsageLimit,
} from "@t3tools/contracts";
import { Schema } from "effect";

import type { CheckpointServiceError } from "../checkpointing/Errors.ts";

/**
 * ProviderAdapterValidationError - Invalid adapter API input.
 */
export class ProviderAdapterValidationError extends Schema.TaggedErrorClass<ProviderAdapterValidationError>()(
  "ProviderAdapterValidationError",
  {
    provider: Schema.String,
    operation: Schema.String,
    issue: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `Provider adapter validation failed (${this.provider}) in ${this.operation}: ${this.issue}`;
  }
}

/**
 * ProviderAdapterSessionNotFoundError - Adapter-owned session id is unknown.
 */
export class ProviderAdapterSessionNotFoundError extends Schema.TaggedErrorClass<ProviderAdapterSessionNotFoundError>()(
  "ProviderAdapterSessionNotFoundError",
  {
    provider: Schema.String,
    threadId: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `Unknown ${this.provider} adapter thread: ${this.threadId}`;
  }
}

/**
 * ProviderAdapterSessionClosedError - Adapter session exists but is closed.
 */
export class ProviderAdapterSessionClosedError extends Schema.TaggedErrorClass<ProviderAdapterSessionClosedError>()(
  "ProviderAdapterSessionClosedError",
  {
    provider: Schema.String,
    threadId: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `${this.provider} adapter thread is closed: ${this.threadId}`;
  }
}

/**
 * ProviderAdapterRequestError - Provider protocol request failed or timed out.
 */
export class ProviderAdapterRequestError extends Schema.TaggedErrorClass<ProviderAdapterRequestError>()(
  "ProviderAdapterRequestError",
  {
    provider: Schema.String,
    method: Schema.String,
    usageLimit: Schema.optional(RuntimeUsageLimit),
    detail: Schema.String,
    /**
     * Set only when the adapter knows the turn input never reached the model,
     * so durable delivery can reject it instead of marking it ambiguous.
     */
    deliveryCertainty: Schema.optional(Schema.Literals(["not_sent", "unknown"])),
    /** Whether a not-sent delivery may be retried automatically. */
    deliveryRetryable: Schema.optional(Schema.Boolean),
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `Provider adapter request failed (${this.provider}) for ${this.method}: ${this.detail}`;
  }
}

/**
 * ProviderAdapterProcessError - Provider process lifecycle failure.
 */
export class ProviderAdapterProcessError extends Schema.TaggedErrorClass<ProviderAdapterProcessError>()(
  "ProviderAdapterProcessError",
  {
    provider: Schema.String,
    threadId: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `Provider adapter process error (${this.provider}) for thread ${this.threadId}: ${this.detail}`;
  }
}

/**
 * ProviderValidationError - Invalid provider API input.
 */
export class ProviderValidationError extends Schema.TaggedErrorClass<ProviderValidationError>()(
  "ProviderValidationError",
  {
    operation: Schema.String,
    issue: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `Provider validation failed in ${this.operation}: ${this.issue}`;
  }
}

/**
 * ProviderValidationBusyError - Validation request already in progress.
 */
export class ProviderValidationBusyError extends Schema.TaggedErrorClass<ProviderValidationBusyError>()(
  "ProviderValidationBusyError",
  {
    message: Schema.String,
  },
) {}

/**
 * ProviderUnsupportedError - Requested provider is not implemented.
 */
export class ProviderUnsupportedError extends Schema.TaggedErrorClass<ProviderUnsupportedError>()(
  "ProviderUnsupportedError",
  {
    provider: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `Provider '${this.provider}' is not implemented`;
  }
}

/**
 * ProviderSessionNotFoundError - Provider-facing session not found.
 */
export class ProviderSessionNotFoundError extends Schema.TaggedErrorClass<ProviderSessionNotFoundError>()(
  "ProviderSessionNotFoundError",
  {
    threadId: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `Unknown provider thread: ${this.threadId}`;
  }
}

/**
 * ProviderSessionDirectoryPersistenceError - Session directory persistence failure.
 */
export class ProviderSessionDirectoryPersistenceError extends Schema.TaggedErrorClass<ProviderSessionDirectoryPersistenceError>()(
  "ProviderSessionDirectoryPersistenceError",
  {
    operation: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `Provider session directory persistence error in ${this.operation}: ${this.detail}`;
  }
}

/**
 * Delivery certainty established at the provider-call boundary. Callers must
 * never infer this from transport text or a more general provider error tag.
 */
export class ProviderTurnDeliveryError extends Schema.TaggedErrorClass<ProviderTurnDeliveryError>()(
  "ProviderTurnDeliveryError",
  {
    certainty: Schema.Literals(["not_sent", "unknown"]),
    retryable: Schema.Boolean,
    usageLimit: Schema.optional(RuntimeUsageLimit),
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return this.detail;
  }
}

const NOT_SENT_SUFFIX = "This message was not sent.";

/**
 * A failure before the provider send call, such as a session that cannot
 * resume, proves the input never left F5. Typed delivery errors keep their
 * own certainty.
 */
export function asPreSendDeliveryError(error: unknown): ProviderTurnDeliveryError {
  if (Schema.is(ProviderTurnDeliveryError)(error)) return error;
  const value = error as {
    detail?: unknown;
    message?: unknown;
    deliveryCertainty?: unknown;
    deliveryRetryable?: unknown;
    retryable?: unknown;
  } | null;
  // Keep a retry hint only where the error itself declares the send safe to repeat.
  const retryable =
    value?.deliveryRetryable === true ||
    (value?.deliveryCertainty === "not_sent" && value.retryable === true);
  const reason =
    typeof value?.detail === "string" && value.detail.trim()
      ? value.detail.trim()
      : typeof value?.message === "string" && value.message.trim()
        ? value.message.trim()
        : "The provider session could not be prepared.";
  return new ProviderTurnDeliveryError({
    certainty: "not_sent",
    retryable,
    detail: reason.endsWith(NOT_SENT_SUFFIX) ? reason : `${reason} ${NOT_SENT_SUFFIX}`,
    cause: error,
  });
}

export type ProviderAdapterError =
  | ProviderAdapterValidationError
  | ProviderAdapterSessionNotFoundError
  | ProviderAdapterSessionClosedError
  | ProviderAdapterRequestError
  | ProviderAdapterProcessError;

/**
 * ProviderDriverError - Provider instance driver creation/probe failure.
 */
export class ProviderDriverError extends Schema.TaggedErrorClass<ProviderDriverError>()(
  "ProviderDriverError",
  {
    driver: Schema.String,
    instanceId: Schema.optional(Schema.String),
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `Provider driver '${this.driver}' failed: ${this.detail}`;
  }
}

/**
 * ProviderSessionActionUnavailableError - A session action was refused after
 * re-checking generation, executable support and policy. Carries the
 * structured reason so stale browsers can explain it instead of retrying.
 */
export class ProviderSessionActionUnavailableError extends Schema.TaggedErrorClass<ProviderSessionActionUnavailableError>()(
  "ProviderSessionActionUnavailableError",
  {
    threadId: Schema.String,
    action: ProviderSessionAction,
    reason: ProviderSessionUnavailableReason,
  },
) {
  override get message(): string {
    return this.reason.message;
  }
}

export type ProviderServiceError =
  | ProviderSessionActionUnavailableError
  | ProviderValidationError
  | ProviderValidationBusyError
  | ProviderUnsupportedError
  | ProviderSessionNotFoundError
  | ProviderSessionDirectoryPersistenceError
  | ProviderTurnDeliveryError
  | ProviderDriverError
  | ProviderAdapterError
  | CheckpointServiceError;

/** Errors whose type alone proves the provider never received the input. */
export function isNotSentProviderError(error: unknown): boolean {
  return (
    Schema.is(ProviderValidationError)(error) ||
    Schema.is(ProviderSessionNotFoundError)(error) ||
    Schema.is(ProviderUnsupportedError)(error) ||
    Schema.is(ProviderSessionActionUnavailableError)(error) ||
    Schema.is(ProviderAdapterValidationError)(error)
  );
}
