import {
  OrchestrationProposedPlan,
  type ThreadSearchInput,
  type ThreadSearchResult,
} from "@t3tools/contracts";
import {
  countThreadSearchOccurrences,
  findThreadSearchOccurrences,
} from "@t3tools/shared/threadSearch";
import { searchableThreadSegments } from "@t3tools/shared/threadFindText";
import { Effect, Schema, Semaphore } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { PersistenceSqlError, toPersistenceSqlError } from "../persistence/Errors.ts";

type Entry = { id: string; kind: "message" | "plan"; createdAt: string; size: number };
type Document = Entry & { count: number };
const empty: ThreadSearchResult = { totalMatches: 0, activeIndex: 0, match: null };

/** Keep bodies out of the scan cache, and serialize scans on the dedicated reader. */
export const makeThreadFind = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const gate = yield* Semaphore.make(1);
  const scans = new Map<string, { revision: string; documents: readonly Document[] }>();
  const refused = (detail: string) =>
    new PersistenceSqlError({ operation: "threads.search", detail });
  const readText = (threadId: string, entry: Entry) =>
    Effect.gen(function* () {
      // Report an error instead of silently claiming complete results for an oversized body.
      if (entry.size > 2 * 1024 * 1024)
        return yield* refused("A message is too large to search safely.");
      const rows =
        entry.kind === "message"
          ? yield* sql<{
              text: string;
            }>`SELECT text FROM projection_thread_messages WHERE thread_id=${threadId} AND message_id=${entry.id}`
          : yield* sql<{
              text: string;
            }>`SELECT plan_markdown AS text FROM projection_thread_proposed_plans WHERE thread_id=${threadId} AND plan_id=${entry.id}`;
      if (!rows[0]) return yield* refused("The matching item is no longer available.");
      return searchableThreadSegments(rows[0].text);
    });
  const search = (input: ThreadSearchInput) =>
    Effect.gen(function* () {
      const query = input.query.trim();
      if (!query) return empty;
      const active =
        yield* sql`SELECT t.thread_id FROM projection_threads t JOIN projection_projects p ON p.project_id=t.project_id WHERE t.thread_id=${input.threadId} AND t.deleted_at IS NULL AND p.deleted_at IS NULL`;
      if (!active.length) return yield* refused("The thread is unavailable.");
      // Every projector contributes: an advancing lagging projector must invalidate a scan
      // even when another projector already owns a higher sequence.
      const revision = JSON.stringify(
        yield* sql<{
          projector: string;
          sequence: number;
        }>`SELECT projector, last_applied_sequence AS sequence FROM projection_state ORDER BY projector`,
      );
      const key = JSON.stringify([input.threadId, query]);
      const cached = scans.get(key);
      let documents = cached?.revision === revision ? cached.documents : undefined;
      if (!documents) {
        const next: Document[] = [];
        let cursor: Entry = { createdAt: "", kind: "message", id: "", size: 0 };
        let visited = 0;
        for (;;) {
          const rows = yield* sql<Entry>`WITH entries AS (
          SELECT message_id AS id, 'message' AS kind, created_at AS "createdAt", length(text) AS size FROM projection_thread_messages WHERE thread_id=${input.threadId} AND role IN ('user','assistant')
          UNION ALL
          SELECT plan_id AS id, 'plan' AS kind, created_at AS "createdAt", length(plan_markdown) AS size FROM projection_thread_proposed_plans WHERE thread_id=${input.threadId}
        ) SELECT * FROM entries WHERE ("createdAt", kind, id) > (${cursor.createdAt},${cursor.kind},${cursor.id}) ORDER BY "createdAt", kind, id LIMIT 64`;
          if (!rows.length) break;
          for (const entry of rows) {
            if (++visited > 200_000)
              return yield* refused("This thread exceeds the search scan limit.");
            const segments = yield* readText(input.threadId, entry);

            const count = segments.reduce(
              (sum, text) => sum + countThreadSearchOccurrences(text, query),
              0,
            );
            if (count) next.push({ ...entry, count });
            yield* Effect.yieldNow;
          }
          cursor = rows[rows.length - 1]!;
        }
        documents = next;
        // At most eight small scans; large threads remain searchable without retaining their index.
        if (next.length <= 2_500) {
          scans.delete(key);
          scans.set(key, { revision, documents });
          while (scans.size > 8) scans.delete(scans.keys().next().value!);
        }
      }
      const totalMatches = documents.reduce((sum, entry) => sum + entry.count, 0);
      if (!totalMatches) return empty;
      const activeIndex = (input.index ?? 0) % totalMatches;
      let occurrence = activeIndex;
      for (const entry of documents) {
        if (occurrence >= entry.count) {
          occurrence -= entry.count;
          continue;
        }
        const segments = yield* readText(input.threadId, entry);
        const plan =
          entry.kind === "plan"
            ? yield* sql`SELECT plan_id AS id, turn_id AS "turnId", plan_markdown AS "planMarkdown", implemented_at AS "implementedAt", implementation_thread_id AS "implementationThreadId", created_at AS "createdAt", updated_at AS "updatedAt" FROM projection_thread_proposed_plans WHERE thread_id=${input.threadId} AND plan_id=${entry.id}`.pipe(
                Effect.flatMap((rows) =>
                  Schema.decodeUnknownEffect(OrchestrationProposedPlan)(rows[0]),
                ),
              )
            : undefined;
        let local = occurrence;
        for (const text of segments) {
          const offsets = findThreadSearchOccurrences(text, query);
          if (local >= offsets.length) {
            local -= offsets.length;
            continue;
          }
          const start = offsets[local]!;
          return {
            totalMatches,
            activeIndex,
            match: {
              entryId: entry.id,
              kind: entry.kind,
              occurrence,
              snippet: text.slice(Math.max(0, start - 60), start + query.length + 100),
              ...(plan ? { plan } : {}),
            },
          } satisfies ThreadSearchResult;
        }
      }
      return yield* refused("Search results changed. Retry the search.");
    });
  return (input: ThreadSearchInput) =>
    gate
      .withPermits(1)(sql.withTransaction(search(input)))
      .pipe(
        Effect.timeout("10 seconds"),
        Effect.mapError(toPersistenceSqlError("threads.search")),
        Effect.withSpan("ThreadFind.search"),
      );
});
