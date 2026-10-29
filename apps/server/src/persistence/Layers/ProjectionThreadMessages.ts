import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import { Effect, Layer, Option, Schema, Struct } from "effect";
import { ChatAttachment, UserMessageSkillCall } from "@t3tools/contracts";

import { toPersistenceSqlError } from "../Errors.ts";
import {
  AddProjectionThreadMessageReasoningTokensInput,
  ProjectionThreadMessageRepository,
  AppendStreamingTextInput,
  type ProjectionThreadMessageRepositoryShape,
  DeleteProjectionThreadMessagesInput,
  GetProjectionThreadMessageInput,
  ListProjectionThreadMessagesInput,
  ProjectionThreadMessage,
} from "../Services/ProjectionThreadMessages.ts";

const ProjectionThreadMessageDbRowSchema = ProjectionThreadMessage.mapFields(
  Struct.assign({
    isStreaming: Schema.Number,
    reasoningText: Schema.NullOr(Schema.String),
    reasoningTokens: Schema.NullOr(Schema.Number),
    reasoningTokensEstimated: Schema.NullOr(Schema.Number),
    skillCall: Schema.NullOr(Schema.fromJsonString(UserMessageSkillCall)),
    attachments: Schema.NullOr(Schema.fromJsonString(Schema.Array(ChatAttachment))),
  }),
);

type ProjectionThreadMessageDbRow = typeof ProjectionThreadMessageDbRowSchema.Type;

const fromDbRow = (row: ProjectionThreadMessageDbRow): ProjectionThreadMessage => ({
  messageId: row.messageId,
  threadId: row.threadId,
  turnId: row.turnId,
  role: row.role,
  text: row.text,
  ...(row.reasoningText !== null ? { reasoningText: row.reasoningText } : {}),
  ...(row.reasoningTokens !== null ? { reasoningTokens: row.reasoningTokens } : {}),
  ...(row.reasoningTokensEstimated !== null
    ? { reasoningTokensEstimated: row.reasoningTokensEstimated === 1 }
    : {}),
  ...(row.skillCall !== null ? { skillCall: row.skillCall } : {}),
  isStreaming: row.isStreaming === 1,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
  ...(row.attachments !== null ? { attachments: row.attachments } : {}),
});

const makeProjectionThreadMessageRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertProjectionThreadMessageRow = SqlSchema.void({
    Request: ProjectionThreadMessage,
    execute: (row) => {
      const nextAttachmentsJson =
        row.attachments !== undefined ? JSON.stringify(row.attachments) : null;
      const nextReasoningText = row.reasoningText ?? null;
      const nextReasoningTokens = row.reasoningTokens ?? null;
      const nextReasoningTokensEstimated =
        row.reasoningTokensEstimated === undefined ? null : row.reasoningTokensEstimated ? 1 : 0;
      const nextSkillCallJson = row.skillCall !== undefined ? JSON.stringify(row.skillCall) : null;
      return sql`
        INSERT INTO projection_thread_messages (
          message_id,
          thread_id,
          turn_id,
          role,
          text,
          reasoning_text,
          reasoning_tokens,
          reasoning_tokens_estimated,
          skill_call_json,
          attachments_json,
          is_streaming,
          created_at,
          updated_at
        )
        VALUES (
          ${row.messageId},
          ${row.threadId},
          ${row.turnId},
          ${row.role},
          ${row.text},
          COALESCE(
            ${nextReasoningText},
            (
              SELECT reasoning_text
              FROM projection_thread_messages
              WHERE message_id = ${row.messageId} AND thread_id = ${row.threadId}
            )
          ),
          COALESCE(
            ${nextReasoningTokens},
            (
              SELECT reasoning_tokens
              FROM projection_thread_messages
              WHERE message_id = ${row.messageId} AND thread_id = ${row.threadId}
            )
          ),
          COALESCE(
            ${nextReasoningTokensEstimated},
            (
              SELECT reasoning_tokens_estimated
              FROM projection_thread_messages
              WHERE message_id = ${row.messageId} AND thread_id = ${row.threadId}
            )
          ),
          COALESCE(
            ${nextSkillCallJson},
            (
              SELECT skill_call_json
              FROM projection_thread_messages
              WHERE message_id = ${row.messageId} AND thread_id = ${row.threadId}
            )
          ),
          COALESCE(
            ${nextAttachmentsJson},
            (
              SELECT attachments_json
              FROM projection_thread_messages
              WHERE message_id = ${row.messageId} AND thread_id = ${row.threadId}
            )
          ),
          ${row.isStreaming ? 1 : 0},
          ${row.createdAt},
          ${row.updatedAt}
        )
        ON CONFLICT (message_id)
        DO UPDATE SET
          thread_id = excluded.thread_id,
          turn_id = excluded.turn_id,
          role = excluded.role,
          text = excluded.text,
          reasoning_text = COALESCE(excluded.reasoning_text, projection_thread_messages.reasoning_text),
          reasoning_tokens = COALESCE(
            excluded.reasoning_tokens,
            projection_thread_messages.reasoning_tokens
          ),
          reasoning_tokens_estimated = COALESCE(
            excluded.reasoning_tokens_estimated,
            projection_thread_messages.reasoning_tokens_estimated
          ),
          skill_call_json = COALESCE(excluded.skill_call_json, projection_thread_messages.skill_call_json),
          attachments_json = COALESCE(
            excluded.attachments_json,
            projection_thread_messages.attachments_json
          ),
          is_streaming = excluded.is_streaming,
          created_at = excluded.created_at,
          updated_at = excluded.updated_at
        WHERE projection_thread_messages.thread_id = excluded.thread_id
      `;
    },
  });

  const listProjectionThreadMessageRows = SqlSchema.findAll({
    Request: ListProjectionThreadMessagesInput,
    Result: ProjectionThreadMessageDbRowSchema,
    execute: ({ threadId }) =>
      sql`
        SELECT
          message_id AS "messageId",
          thread_id AS "threadId",
          turn_id AS "turnId",
          role,
          text,
          reasoning_text AS "reasoningText",
          reasoning_tokens AS "reasoningTokens",
          reasoning_tokens_estimated AS "reasoningTokensEstimated",
          skill_call_json AS "skillCall",
          attachments_json AS "attachments",
          is_streaming AS "isStreaming",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM projection_thread_messages
        WHERE thread_id = ${threadId}
        ORDER BY created_at ASC, message_id ASC
      `,
  });

  const getProjectionThreadMessageRow = SqlSchema.findOneOption({
    Request: GetProjectionThreadMessageInput,
    Result: ProjectionThreadMessageDbRowSchema,
    execute: ({ threadId, messageId }) =>
      sql`
        SELECT
          message_id AS "messageId",
          thread_id AS "threadId",
          turn_id AS "turnId",
          role,
          text,
          reasoning_text AS "reasoningText",
          reasoning_tokens AS "reasoningTokens",
          reasoning_tokens_estimated AS "reasoningTokensEstimated",
          skill_call_json AS "skillCall",
          attachments_json AS "attachments",
          is_streaming AS "isStreaming",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM projection_thread_messages
        WHERE message_id = ${messageId} AND thread_id = ${threadId}
      `,
  });

  const deleteProjectionThreadMessageRows = SqlSchema.void({
    Request: DeleteProjectionThreadMessagesInput,
    execute: ({ threadId }) =>
      sql`
        DELETE FROM projection_thread_messages
        WHERE thread_id = ${threadId}
      `,
  });

  const appendStreamingTextRows = SqlSchema.findAll({
    Request: AppendStreamingTextInput,
    Result: Schema.Struct({ messageId: Schema.String }),
    execute: (input) => sql`
      UPDATE projection_thread_messages SET
        text = text || ${input.delta},
        reasoning_text = CASE WHEN ${input.reasoningDelta === undefined ? 1 : 0} = 1 THEN reasoning_text
          ELSE COALESCE(reasoning_text, '') || ${input.reasoningDelta ?? ""} END,
        updated_at = ${input.updatedAt}, is_streaming = 1
      WHERE message_id = ${input.messageId} AND thread_id = ${input.threadId}
        AND turn_id IS ${input.turnId} AND role = ${input.role}
      RETURNING message_id AS "messageId"
    `,
  });
  const appendStreamingText: ProjectionThreadMessageRepositoryShape["appendStreamingText"] = (
    input,
  ) =>
    appendStreamingTextRows(input).pipe(
      Effect.map((rows) => rows.length),
      Effect.mapError(
        toPersistenceSqlError("ProjectionThreadMessageRepository.appendStreamingText:query"),
      ),
    );

  const addReasoningTokensRow = SqlSchema.void({
    Request: AddProjectionThreadMessageReasoningTokensInput,
    execute: (input) => sql`
      UPDATE projection_thread_messages SET
        reasoning_tokens = COALESCE(reasoning_tokens, 0) + ${input.tokens},
        reasoning_tokens_estimated = MAX(
          COALESCE(reasoning_tokens_estimated, 0),
          ${input.estimated ? 1 : 0}
        )
      WHERE message_id = ${input.messageId} AND thread_id = ${input.threadId}
    `,
  });
  const addReasoningTokens: ProjectionThreadMessageRepositoryShape["addReasoningTokens"] = (
    input,
  ) =>
    addReasoningTokensRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionThreadMessageRepository.addReasoningTokens:query"),
      ),
    );

  const upsert: ProjectionThreadMessageRepositoryShape["upsert"] = (row) =>
    upsertProjectionThreadMessageRow(row).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionThreadMessageRepository.upsert:query")),
    );

  const listByThreadId: ProjectionThreadMessageRepositoryShape["listByThreadId"] = (input) =>
    listProjectionThreadMessageRows(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionThreadMessageRepository.listByThreadId:query"),
      ),
      Effect.map((rows) => rows.map(fromDbRow)),
    );

  const getByMessageId: ProjectionThreadMessageRepositoryShape["getByMessageId"] = (input) =>
    getProjectionThreadMessageRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionThreadMessageRepository.getByMessageId:query"),
      ),
      Effect.map(Option.map(fromDbRow)),
    );

  const deleteByThreadId: ProjectionThreadMessageRepositoryShape["deleteByThreadId"] = (input) =>
    deleteProjectionThreadMessageRows(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionThreadMessageRepository.deleteByThreadId:query"),
      ),
    );

  return {
    appendStreamingText,
    upsert,
    addReasoningTokens,
    listByThreadId,
    getByMessageId,
    deleteByThreadId,
  } satisfies ProjectionThreadMessageRepositoryShape;
});

export const ProjectionThreadMessageRepositoryLive = Layer.effect(
  ProjectionThreadMessageRepository,
  makeProjectionThreadMessageRepository,
);
