import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE forge_accounts (id TEXT PRIMARY KEY, provider TEXT NOT NULL, host TEXT NOT NULL, login TEXT NOT NULL, viewer_id TEXT NOT NULL, generation TEXT NOT NULL, UNIQUE(provider, host, login))`;
  yield* sql`CREATE TABLE forge_account_routing (provider TEXT NOT NULL, host TEXT NOT NULL, repository TEXT NOT NULL, account_id TEXT NOT NULL REFERENCES forge_accounts(id), PRIMARY KEY(provider,host,repository))`;
  yield* sql`CREATE TABLE pr_hub_viewed_files (account_id TEXT NOT NULL, pr_key TEXT NOT NULL, path TEXT NOT NULL, head_oid TEXT NOT NULL, base_oid TEXT NOT NULL, PRIMARY KEY(account_id,pr_key,path,head_oid,base_oid))`;
  yield* sql`CREATE TABLE forge_pr_hub_state (account_id TEXT NOT NULL, pr_key TEXT NOT NULL, data_json TEXT NOT NULL, PRIMARY KEY(account_id,pr_key))`;
  yield* sql`CREATE TABLE forge_operations (account_id TEXT NOT NULL, operation_id TEXT NOT NULL, pr_key TEXT NOT NULL, payload_json TEXT NOT NULL, status TEXT NOT NULL, progress_json TEXT, result_json TEXT, PRIMARY KEY(account_id,operation_id))`;
  yield* sql`CREATE UNIQUE INDEX forge_operations_active_pr ON forge_operations(account_id,pr_key) WHERE status IN ('running','outcome_unknown')`;
});
