import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqliteClient from "../NodeSqliteClient.ts";
import migration from "./095_AttachmentOwnerKinds.ts";
const layer = it.layer(SqliteClient.layerMemory());
layer("attachment owner migration", (it) => {
  it.effect(
    "rebuilds an existing table without losing owners and preserves attachment cascade",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`CREATE TABLE attachments(attachment_id TEXT PRIMARY KEY)`;
        yield* sql`CREATE TABLE attachment_owners(attachment_id TEXT NOT NULL REFERENCES attachments(attachment_id) ON DELETE CASCADE, owner_kind TEXT NOT NULL CHECK(owner_kind IN ('ingress','queue_item','message')), owner_id TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(attachment_id,owner_kind,owner_id))`;
        yield* sql`CREATE INDEX idx_attachment_owners_owner ON attachment_owners(owner_kind,owner_id)`;
        yield* sql`INSERT INTO attachments VALUES ('image-1')`;
        yield* sql`INSERT INTO attachment_owners VALUES ('image-1','message','prompt-1','2026-09-30')`;
        yield* migration;
        yield* sql`INSERT INTO attachment_owners VALUES ('image-1','user_input','request-1','2026-09-30'), ('image-1','rewind_draft','rewind-1','2026-09-30')`;
        const owners = yield* sql<{
          owner_kind: string;
        }>`SELECT owner_kind FROM attachment_owners ORDER BY owner_kind`;
        assert.deepEqual(
          owners.map((owner) => owner.owner_kind),
          ["message", "rewind_draft", "user_input"],
        );
        yield* sql`DELETE FROM attachments WHERE attachment_id = 'image-1'`;
        assert.equal((yield* sql`SELECT * FROM attachment_owners`).length, 0);
      }),
  );
});
