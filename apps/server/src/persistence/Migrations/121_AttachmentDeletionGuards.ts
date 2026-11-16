import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // As with migration 109, repair fixtures may intentionally omit attachments.
  const tables = yield* sql<{
    name: string;
  }>`SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('attachments', 'attachment_owners')`;
  if (tables.length !== 2) return;
  yield* sql`CREATE TRIGGER attachment_owner_reject_deleting BEFORE INSERT ON attachment_owners
    WHEN EXISTS (SELECT 1 FROM attachments WHERE attachment_id = NEW.attachment_id AND lifecycle = 'deleting')
    BEGIN SELECT RAISE(ABORT, 'Attachment is unavailable: deletion in progress'); END`;
  yield* sql`CREATE TRIGGER attachment_reject_resurrection BEFORE UPDATE OF lifecycle ON attachments
    WHEN OLD.lifecycle = 'deleting' AND NEW.lifecycle <> 'deleting'
    BEGIN SELECT RAISE(ABORT, 'Attachment is unavailable: deletion in progress'); END`;
  yield* sql`CREATE TRIGGER attachment_reject_replacement BEFORE INSERT ON attachments
    WHEN EXISTS (SELECT 1 FROM attachments WHERE attachment_id = NEW.attachment_id AND lifecycle = 'deleting')
    BEGIN SELECT RAISE(ABORT, 'Attachment is unavailable: deletion in progress'); END`;
});
