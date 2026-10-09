import { Schema } from "effect";
import { ApprovalRequestId, IsoDateTime, TurnId, TrimmedNonEmptyString } from "./baseSchemas";
import { ElicitationDescriptor, ElicitationReceiptState } from "./elicitation";
export const UserInputQuestionOption = Schema.Struct({
  label: TrimmedNonEmptyString,
  description: TrimmedNonEmptyString,
});
export type UserInputQuestionOption = typeof UserInputQuestionOption.Type;

export const UserInputQuestion = Schema.Struct({
  id: TrimmedNonEmptyString,
  header: TrimmedNonEmptyString,
  question: TrimmedNonEmptyString,
  options: Schema.Array(UserInputQuestionOption),
  multiSelect: Schema.optional(Schema.Boolean),
  optional: Schema.optional(Schema.Boolean),
});
export type UserInputQuestion = typeof UserInputQuestion.Type;

export const PendingUserInput = Schema.Struct({
  requestId: ApprovalRequestId,
  turnId: Schema.NullOr(TurnId),
  createdAt: IsoDateTime,
  /** Transport: "message" answers arrive as a follow-up turn; absent answers the native request. */
  responseMode: Schema.optional(Schema.Literal("message")),
  /**
   * Semantics: `false` never holds the turn open and survives the turn's end
   * while the session lives. Absent means blocking unless `responseMode` is "message".
   */
  blocking: Schema.optional(Schema.Boolean),
  questions: Schema.Array(UserInputQuestion),
  /** Provider form/URL request answered through the private elicitation RPC. */
  elicitation: Schema.optional(ElicitationDescriptor),
  /** Value-free delivery state for elicitations; absent means `pending`. */
  receipt: Schema.optional(ElicitationReceiptState),
});
export type PendingUserInput = typeof PendingUserInput.Type;
