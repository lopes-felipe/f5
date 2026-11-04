import type { RuntimeMode } from "@t3tools/contracts";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** Typed against the contract, so renaming the mode breaks the build instead of the bypass. */
const FULL_ACCESS: RuntimeMode = "full-access";

/**
 * Read when each request arrives, so switching a thread out of full access takes effect at
 * once. A deleted thread never qualifies, even if a process it started is still running; an
 * archived one still does, because archiving only tidies the sidebar and its terminals and
 * agents keep their access.
 */
export const browserOpenThreadIsFullAccess = (threadId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{
      runtimeMode: string;
    }>`SELECT runtime_mode AS "runtimeMode" FROM projection_threads WHERE thread_id=${threadId} AND deleted_at IS NULL`;
    return rows[0]?.runtimeMode === FULL_ACCESS;
  });
