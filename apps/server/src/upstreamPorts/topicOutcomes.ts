import type { UpstreamPortOutcome } from "@t3tools/contracts";
import {
  outcomeForTopic,
  type ParsedUpstreamOutcomes,
} from "@t3tools/shared/upstreamPortsOutcomes";
import { Effect } from "effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";

import { readTurnAssistantMessages } from "../orchestration/turnAssistantMessage.ts";

export interface TopicOutcomeReceipt {
  readonly projectId: string;
  readonly topicId: string;
  readonly epoch: number;
  readonly threadId: string;
  readonly turnId: string;
  readonly messageId: string;
  readonly outcome: UpstreamPortOutcome | { readonly kind: "invalid"; readonly detail: string };
  readonly explicit: boolean;
  readonly sourceAt: string;
}

/** Absence preserves evidence; invalid or ambiguous newer evidence supersedes it durably. */
export function recoveredTopicOutcome(
  parsed: ParsedUpstreamOutcomes,
  topicId: string,
  topicCount: number,
  prMembership: "included" | "excluded" | "unknown" = "unknown",
): TopicOutcomeReceipt["outcome"] | null {
  const error =
    parsed.errors.get(topicId) ??
    (!parsed.byTopic.has(topicId) ? parsed.errors.get("thread") : undefined);
  if (error) return { kind: "invalid", detail: error };
  if (parsed.byTopic.has(topicId)) return parsed.byTopic.get(topicId)!;
  if (topicCount > 1 && parsed.thread?.kind === "pr") {
    if (prMembership === "excluded") return null;
    if (prMembership === "unknown")
      return {
        kind: "invalid",
        detail: "The later PR's topic trailers could not be fully verified.",
      };
  }
  return outcomeForTopic(parsed, topicId, topicCount);
}

export function makeTopicOutcomeStore(sql: SqlClient.SqlClient) {
  return {
    put: (receipt: TopicOutcomeReceipt) => sql`INSERT INTO upstream_port_topic_outcomes
      (project_id,topic_id,epoch,thread_id,turn_id,message_id,kind,detail,explicit,source_at)
      VALUES (${receipt.projectId},${receipt.topicId},${receipt.epoch},${receipt.threadId},
        ${receipt.turnId},${receipt.messageId},${receipt.outcome.kind},${receipt.outcome.detail},
        ${receipt.explicit ? 1 : 0},${receipt.sourceAt})
      ON CONFLICT(project_id,topic_id,epoch,thread_id) DO UPDATE SET
        turn_id = excluded.turn_id,message_id = excluded.message_id,kind = excluded.kind,
        detail = excluded.detail,explicit = excluded.explicit,source_at = excluded.source_at
      WHERE (excluded.source_at > upstream_port_topic_outcomes.source_at
            OR excluded.source_at = upstream_port_topic_outcomes.source_at
              AND excluded.message_id >= upstream_port_topic_outcomes.message_id)`,
    list: (projectId: string, threadId: string) => readReceipts(sql, projectId, [threadId]),
    listForThreads: (projectId: string, threadIds: ReadonlyArray<string>) =>
      readReceipts(sql, projectId, threadIds),
  };
}

function readReceipts(
  sql: SqlClient.SqlClient,
  projectId: string,
  threadIds: ReadonlyArray<string>,
) {
  if (!threadIds.length) return Effect.succeed([] as TopicOutcomeReceipt[]);
  return sql<{
    thread_id: string;
    topic_id: string;
    epoch: number;
    turn_id: string;
    message_id: string;
    kind: TopicOutcomeReceipt["outcome"]["kind"];
    detail: string;
    explicit: number;
    source_at: string;
  }>`SELECT * FROM upstream_port_topic_outcomes
        WHERE project_id = ${projectId} AND ${sql.in("thread_id", threadIds)}`.pipe(
    Effect.map((rows): TopicOutcomeReceipt[] =>
      rows.map((row) => ({
        projectId,
        threadId: row.thread_id,
        topicId: row.topic_id,
        epoch: Number(row.epoch),
        turnId: row.turn_id,
        messageId: row.message_id,
        outcome: { kind: row.kind, detail: row.detail },
        explicit: !!row.explicit,
        sourceAt: row.source_at,
      })),
    ),
  );
}

/** Recovery is paged, scoped to the admitted thread, and never reads unprocessed turns. */
export function readSettledPortReplies(
  sql: SqlClient.SqlClient,
  threadId: string,
  admittedAt: string,
) {
  return Effect.gen(function* () {
    const replies: Array<{
      threadId: string;
      turnId: string;
      id: string;
      text: string;
      sourceAt: string;
    }> = [];
    for (let offset = 0; ; offset += 100) {
      const turns = yield* sql<{ turn_id: string; requested_at: string }>`
        SELECT turn_id,requested_at FROM projection_turns
        WHERE thread_id = ${threadId} AND state = 'completed'
          AND processing_quiesced_at IS NOT NULL AND turn_id IS NOT NULL
          AND requested_at >= ${admittedAt}
        ORDER BY requested_at,row_id LIMIT 100 OFFSET ${offset}`;
      const messages = yield* readTurnAssistantMessages(
        sql,
        turns.map((turn) => ({ threadId, turnId: turn.turn_id })),
      );
      const byTurn = new Map(messages.map((message) => [message.turnId, message]));
      for (const turn of turns) {
        const message = byTurn.get(turn.turn_id);
        if (message) replies.push({ ...message, sourceAt: turn.requested_at });
      }
      if (turns.length < 100) return replies;
    }
  });
}
