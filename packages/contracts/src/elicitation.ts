import { Schema } from "effect";
import { ApprovalRequestId, NonNegativeInt, ThreadId, TrimmedNonEmptyString } from "./baseSchemas";

/** Bounds for provider-requested forms; larger or richer requests are cancelled visibly. */
export const ELICITATION_MAX_FIELDS = 32;
export const ELICITATION_MAX_BYTES = 64 * 1024;
export const ELICITATION_MAX_OPTIONS = 256;

export const ElicitationStringFormat = Schema.Literals(["email", "uri", "date", "date-time"]);
export type ElicitationStringFormat = typeof ElicitationStringFormat.Type;

export const ElicitationFieldOption = Schema.Struct({
  value: Schema.String,
  label: Schema.String,
});
export type ElicitationFieldOption = typeof ElicitationFieldOption.Type;

export const ElicitationValue = Schema.Union([
  Schema.String,
  Schema.Number,
  Schema.Boolean,
  Schema.Array(Schema.String),
]);
export type ElicitationValue = typeof ElicitationValue.Type;

/** One normalized form field. Every field is shown; none is filled in without the user. */
export const ElicitationField = Schema.Struct({
  key: TrimmedNonEmptyString,
  title: Schema.String,
  description: Schema.optional(Schema.String),
  required: Schema.Boolean,
  type: Schema.Literals(["string", "number", "integer", "boolean", "enum", "multiselect"]),
  format: Schema.optional(ElicitationStringFormat),
  minLength: Schema.optional(NonNegativeInt),
  maxLength: Schema.optional(NonNegativeInt),
  minimum: Schema.optional(Schema.Number),
  maximum: Schema.optional(Schema.Number),
  minItems: Schema.optional(NonNegativeInt),
  maxItems: Schema.optional(NonNegativeInt),
  options: Schema.optional(Schema.Array(ElicitationFieldOption)),
  /** Provider-suggested value, shown pre-filled; only submitted if the user keeps it. */
  suggestedValue: Schema.optional(ElicitationValue),
});
export type ElicitationField = typeof ElicitationField.Type;

/**
 * Value-free description of a provider form or URL request. Answers are never
 * part of this descriptor, of thread events or of activity payloads.
 */
export const ElicitationDescriptor = Schema.Struct({
  mode: Schema.Literals(["form", "url"]),
  message: Schema.String,
  serverName: Schema.optional(Schema.String),
  title: Schema.optional(Schema.String),
  /** Provider correlation id (URL elicitation id); display/correlation only. */
  nativeId: Schema.optional(Schema.String),
  /** Session generation that owns the request; stamped by the server. */
  generation: Schema.optional(NonNegativeInt),
  fields: Schema.optional(Schema.Array(ElicitationField)),
  url: Schema.optional(Schema.String),
});
export type ElicitationDescriptor = typeof ElicitationDescriptor.Type;

/**
 * Value-free delivery receipt. `submitted` means F5 handed the answer to the
 * provider; only a correlated native completion makes it `resolved`. A
 * `submitted` request whose transport is lost becomes `indeterminate` and is
 * never resent; the user must dismiss it.
 */
export const ElicitationReceiptState = Schema.Literals([
  "pending",
  "submitted",
  "resolved",
  "cancelled",
  "indeterminate",
]);
export type ElicitationReceiptState = typeof ElicitationReceiptState.Type;

export const ElicitationAction = Schema.Literals(["accept", "decline", "cancel"]);
export type ElicitationAction = typeof ElicitationAction.Type;

/** Answer content stays loosely typed on the wire so decode errors never echo values. */
export const ElicitationContent = Schema.Record(Schema.String, Schema.Unknown);
export type ElicitationContent = typeof ElicitationContent.Type;

export const ElicitationSubmitInput = Schema.Struct({
  threadId: ThreadId,
  requestId: ApprovalRequestId,
  generation: NonNegativeInt,
  action: ElicitationAction,
  content: Schema.optional(ElicitationContent),
});
export type ElicitationSubmitInput = typeof ElicitationSubmitInput.Type;

export const ElicitationSubmitResult = Schema.Struct({
  state: ElicitationReceiptState,
});
export type ElicitationSubmitResult = typeof ElicitationSubmitResult.Type;

export const ELICITATION_WS_METHODS = {
  submit: "elicitation.submit",
} as const;
