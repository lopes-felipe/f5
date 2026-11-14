import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Every page of the pull request queue reads the threads linked to its rows, by pull
 * request. The table was indexed by thread only, so that read scanned every link once per
 * row.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE INDEX IF NOT EXISTS projection_thread_pull_requests_pull_request_idx
    ON projection_thread_pull_requests(provider, host, repository, number)`;
});
