import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE projection_thread_pull_requests (
    link_id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL REFERENCES projection_threads(thread_id) ON DELETE CASCADE,
    provider TEXT NOT NULL, host TEXT NOT NULL, repository TEXT NOT NULL,
    number INTEGER NOT NULL, title TEXT NOT NULL, url TEXT NOT NULL, updated_at TEXT NOT NULL,
    UNIQUE(thread_id, provider, host, repository, number)
  )`;
  yield* sql`CREATE INDEX projection_thread_pull_requests_thread ON projection_thread_pull_requests(thread_id)`;
  const indexLink = `
    DELETE FROM search_documents WHERE document_key = 'pull-request:' || new.link_id;
    INSERT INTO search_documents(document_key, kind, entity_id, project_id, thread_id, title, content, created_at)
    SELECT 'pull-request:' || new.link_id, 'thread', new.thread_id, thread.project_id, new.thread_id,
      thread.title, new.title || ' ' || new.repository || '#' || new.number || ' ' || new.url, new.updated_at
    FROM projection_threads AS thread WHERE thread.thread_id = new.thread_id AND thread.deleted_at IS NULL;
  `;
  for (const operation of ["INSERT", "UPDATE"] as const) {
    yield* sql.unsafe(
      `CREATE TRIGGER search_thread_pull_requests_${operation.toLowerCase()} AFTER ${operation} ON projection_thread_pull_requests BEGIN ${indexLink} END`,
    );
  }
  yield* sql`CREATE TRIGGER search_thread_pull_requests_delete AFTER DELETE ON projection_thread_pull_requests BEGIN
    DELETE FROM search_documents WHERE document_key = 'pull-request:' || old.link_id;
  END`;
});
