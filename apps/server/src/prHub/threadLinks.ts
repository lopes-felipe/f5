import { ThreadId, ThreadPullRequestLink } from "@t3tools/contracts";
import { Effect, Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** Shared local projection reader; title jobs need only the five most recent links. */
export const readThreadPullRequestLinks = (threadId: ThreadId, limit: 5 | 50 = 50) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows =
      yield* sql`SELECT provider,host,repository,number,title,url FROM projection_thread_pull_requests WHERE thread_id=${threadId} ORDER BY updated_at DESC, link_id DESC LIMIT ${limit}`;
    return yield* Schema.decodeUnknownEffect(Schema.Array(ThreadPullRequestLink))(rows);
  });

export function threadTitlePullRequestContext(
  links: ReadonlyArray<ThreadPullRequestLink>,
): string | undefined {
  if (links.length === 0) return undefined;
  return JSON.stringify(
    links.slice(0, 5).map((link) => ({
      provider: link.provider,
      host: link.host.slice(0, 253),
      repository: link.repository.slice(0, 1_024),
      number: link.number,
      title: link.title,
    })),
  );
}
