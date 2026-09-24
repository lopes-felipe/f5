import { Effect, Schema } from "effect";
import { expect, it } from "vitest";
import { toPersistenceSqlError } from "./Errors.ts";

it.each([
  { cause: { errcode: 5, errstr: "database is locked", message: "private query values" } },
  { cause: { name: "SQLiteError", errno: 5, message: "private query values" } },
])("reports SQLite conditions without SQL or bound values", (cause) => {
  const error = toPersistenceSqlError("insert")(cause);
  expect(error.message).toContain("SQLITE(5)");
  expect(error.message).not.toContain("private");
});
it("does not expose unclassified driver messages", () => {
  expect(toPersistenceSqlError("insert")(new Error("private values")).message).not.toContain(
    "private",
  );
});

it("reports schema tags without rejected values", () => {
  const cause = Effect.runSync(
    Schema.decodeUnknownEffect(Schema.Number)("private query value").pipe(Effect.flip),
  );
  const message = toPersistenceSqlError("insert")(cause).message;
  expect(message).toContain("Schema issue:");
  expect(message).not.toContain("private");
});
