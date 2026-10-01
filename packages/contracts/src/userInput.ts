import { Schema } from "effect";
import { ApprovalRequestId, IsoDateTime, TurnId, TrimmedNonEmptyString } from "./baseSchemas";
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
  responseMode: Schema.optional(Schema.Literal("message")),
  questions: Schema.Array(UserInputQuestion),
});
export type PendingUserInput = typeof PendingUserInput.Type;
