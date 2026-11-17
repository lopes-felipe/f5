import { Schema } from "effect";
import { MessageId, ThreadId, TurnId, TrimmedNonEmptyString } from "./baseSchemas";

/** A bounded reference, not the full response or a grant to read another thread. */
export const AssistantResponseContext = Schema.Struct({
  version: Schema.Literal(1),
  kind: Schema.Literals(["quote", "response"]),
  threadId: ThreadId,
  messageId: MessageId,
  turnId: Schema.optional(TurnId),
  text: Schema.String.check(Schema.isMaxLength(4000)),
  prefix: Schema.optional(Schema.String.check(Schema.isMaxLength(150))),
  suffix: Schema.optional(Schema.String.check(Schema.isMaxLength(150))),
  subagents: Schema.optional(
    Schema.Array(
      Schema.Struct({
        threadId: ThreadId,
        title: TrimmedNonEmptyString.check(Schema.isMaxLength(120)),
      }),
    ).check(Schema.isMaxLength(20)),
  ),
});
export type AssistantResponseContext = typeof AssistantResponseContext.Type;
