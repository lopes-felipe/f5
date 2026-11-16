import { ServiceMap } from "effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";

/** A separate, read-only connection. Never use it for projection or queue writes. */
export class ReadSqlClient extends ServiceMap.Service<ReadSqlClient, SqlClient.SqlClient>()(
  "t3/persistence/ReadSqlClient",
) {}
