/**
 * ProjectionThreadMessageRepository - Projection repository interface for messages.
 *
 * Owns persistence operations for projected thread messages rendered in the
 * orchestration read model.
 *
 * @module ProjectionThreadMessageRepository
 */
import {
  ChatAttachment,
  OrchestrationMessageRole,
  MessageId,
  NonNegativeInt,
  ThreadId,
  TurnId,
  IsoDateTime,
  UserMessageSkillCall,
} from "@t3tools/contracts";
import { Schema, ServiceMap } from "effect";
import type { Effect, Option } from "effect";

import type { ProjectionRepositoryError } from "../Errors.ts";

export const ProjectionThreadMessage = Schema.Struct({
  messageId: MessageId,
  threadId: ThreadId,
  turnId: Schema.NullOr(TurnId),
  role: OrchestrationMessageRole,
  text: Schema.String,
  reasoningText: Schema.optional(Schema.String),
  reasoningTokens: Schema.optional(NonNegativeInt),
  reasoningTokensEstimated: Schema.optional(Schema.Boolean),
  skillCall: Schema.optional(UserMessageSkillCall),
  attachments: Schema.optional(Schema.Array(ChatAttachment)),
  isStreaming: Schema.Boolean,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type ProjectionThreadMessage = typeof ProjectionThreadMessage.Type;

export const AddProjectionThreadMessageReasoningTokensInput = Schema.Struct({
  messageId: MessageId,
  threadId: ThreadId,
  tokens: NonNegativeInt,
  estimated: Schema.Boolean,
});
export type AddProjectionThreadMessageReasoningTokensInput =
  typeof AddProjectionThreadMessageReasoningTokensInput.Type;

export const ListProjectionThreadMessagesInput = Schema.Struct({
  threadId: ThreadId,
});
export type ListProjectionThreadMessagesInput = typeof ListProjectionThreadMessagesInput.Type;

export const GetProjectionThreadMessageInput = Schema.Struct({
  threadId: ThreadId,
  messageId: MessageId,
});
export type GetProjectionThreadMessageInput = typeof GetProjectionThreadMessageInput.Type;

export const DeleteProjectionThreadMessagesInput = Schema.Struct({
  threadId: ThreadId,
});
export type DeleteProjectionThreadMessagesInput = typeof DeleteProjectionThreadMessagesInput.Type;

export const AppendStreamingTextInput = Schema.Struct({
  messageId: MessageId,
  threadId: ThreadId,
  turnId: Schema.NullOr(TurnId),
  role: OrchestrationMessageRole,
  delta: Schema.String,
  reasoningDelta: Schema.optional(Schema.String),
  updatedAt: IsoDateTime,
});
export type AppendStreamingTextInput = typeof AppendStreamingTextInput.Type;

/**
 * ProjectionThreadMessageRepositoryShape - Service API for projected thread messages.
 */
export interface ProjectionThreadMessageRepositoryShape {
  /** Append only to the exact existing message identity; zero rows requires upsert fallback. */
  readonly appendStreamingText: (
    input: AppendStreamingTextInput,
  ) => Effect.Effect<number, ProjectionRepositoryError>;

  /**
   * Insert or replace a projected thread message row.
   *
   * Upserts by `messageId`. A row owned by another thread is never
   * overwritten.
   */
  readonly upsert: (
    message: ProjectionThreadMessage,
  ) => Effect.Effect<void, ProjectionRepositoryError>;

  /** Add to a message's reasoning-token count; the estimated flag is sticky. */
  readonly addReasoningTokens: (
    input: AddProjectionThreadMessageReasoningTokensInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;

  /**
   * List projected thread messages for a thread.
   *
   * Returned in ascending creation order.
   */
  readonly listByThreadId: (
    input: ListProjectionThreadMessagesInput,
  ) => Effect.Effect<ReadonlyArray<ProjectionThreadMessage>, ProjectionRepositoryError>;

  /**
   * Read one projected message, scoped to its thread.
   *
   * Rows are keyed by `messageId` alone, so the thread scope keeps a message
   * id reused by another thread from being returned.
   */
  readonly getByMessageId: (
    input: GetProjectionThreadMessageInput,
  ) => Effect.Effect<Option.Option<ProjectionThreadMessage>, ProjectionRepositoryError>;

  /**
   * Delete projected thread messages by thread.
   */
  readonly deleteByThreadId: (
    input: DeleteProjectionThreadMessagesInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
}

/**
 * ProjectionThreadMessageRepository - Service tag for message projection persistence.
 */
export class ProjectionThreadMessageRepository extends ServiceMap.Service<
  ProjectionThreadMessageRepository,
  ProjectionThreadMessageRepositoryShape
>()("t3/persistence/Services/ProjectionThreadMessages/ProjectionThreadMessageRepository") {}
