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

/** Longest message preview a context page returns, in code points. */
export const THREAD_CONTEXT_PREVIEW_MAX_CHARS = 4096;
/** Longest chunk a context item read returns, in code points. */
export const THREAD_CONTEXT_ITEM_MAX_CHARS = 16384;

export const ThreadContextAttachment = Schema.Struct({
  name: Schema.String,
  type: Schema.String,
});
export type ThreadContextAttachment = typeof ThreadContextAttachment.Type;

/**
 * A user or assistant message read as context for another thread: its text is bounded in SQL
 * and reasoning and attachment payloads are left out.
 */
export const ProjectionThreadMessageContext = Schema.Struct({
  messageId: MessageId,
  role: OrchestrationMessageRole,
  text: Schema.String,
  /** Length of the full text in code points, matching SQLite `length`. */
  totalLength: NonNegativeInt,
  attachments: Schema.Array(ThreadContextAttachment),
  isStreaming: Schema.Boolean,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type ProjectionThreadMessageContext = typeof ProjectionThreadMessageContext.Type;

export const ListProjectionThreadMessageContextPageInput = Schema.Struct({
  threadId: ThreadId,
  /** Exclusive keyset cursor: only rows ordered before it are returned. */
  before: Schema.optional(Schema.Struct({ createdAt: Schema.String, messageId: Schema.String })),
  limit: NonNegativeInt,
});
export type ListProjectionThreadMessageContextPageInput =
  typeof ListProjectionThreadMessageContextPageInput.Type;

export const GetProjectionThreadMessageContextItemInput = Schema.Struct({
  threadId: ThreadId,
  messageId: MessageId,
  /** Code points to skip. */
  offset: NonNegativeInt,
});
export type GetProjectionThreadMessageContextItemInput =
  typeof GetProjectionThreadMessageContextItemInput.Type;

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
   * Read up to `limit + 1` user and assistant messages, newest first, ordered by
   * `(createdAt, messageId)` descending. Each text is cut to a preview.
   */
  readonly listContextPage: (
    input: ListProjectionThreadMessageContextPageInput,
  ) => Effect.Effect<ReadonlyArray<ProjectionThreadMessageContext>, ProjectionRepositoryError>;

  /** Read one chunk of a user or assistant message's text, scoped to its thread. */
  readonly getContextItem: (
    input: GetProjectionThreadMessageContextItemInput,
  ) => Effect.Effect<Option.Option<ProjectionThreadMessageContext>, ProjectionRepositoryError>;

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
