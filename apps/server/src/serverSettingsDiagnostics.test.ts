import { assert, it } from "@effect/vitest";
import { Cause, Exit, Option, Schema, SchemaIssue } from "effect";
import { summarizeSettingsIssue } from "./serverSettingsDiagnostics.ts";

function issueFor(
  schema: Schema.Top & { readonly DecodingServices: never },
  value: unknown,
): SchemaIssue.Issue {
  const result = Schema.decodeUnknownExit(schema)(value, { errors: "all" });
  if (Exit.isSuccess(result)) throw new Error("Expected a validation failure");
  const failure = Cause.findErrorOption(result.cause);
  if (Option.isNone(failure)) throw new Error("Expected a schema failure");
  return failure.value.issue;
}

it("names known top-level fields without exposing credential values or dynamic record keys", () => {
  const secret = "diagnostic-private-fixture";
  const schema = Schema.Struct({
    providerInstances: Schema.Record(Schema.String, Schema.Struct({ enabled: Schema.Boolean })),
  });
  const issue = issueFor(schema, { providerInstances: { [secret]: { enabled: secret } } });
  assert.include(SchemaIssue.makeFormatterDefault()(issue), secret);
  assert.equal(summarizeSettingsIssue(issue), "Invalid settings fields: providerInstances");
});

it("does not echo invalid JSON syntax or unknown top-level field names", () => {
  const secret = "syntax-private-fixture";
  const syntax = issueFor(Schema.fromJsonString(Schema.Unknown), `{"token":"${secret}`);
  assert.equal(summarizeSettingsIssue(syntax), "Invalid settings document");
  const unknownField = issueFor(Schema.Struct({ [secret]: Schema.Boolean }), { [secret]: secret });
  assert.equal(summarizeSettingsIssue(unknownField), "Invalid settings document");
});

it("bounds traversal and output for deeply nested validation failures", () => {
  let issue = issueFor(Schema.Boolean, "deep-private-fixture");
  for (let i = 0; i < 10_000; i++) issue = new SchemaIssue.Pointer(["deep-private-fixture"], issue);
  const summary = summarizeSettingsIssue(issue);
  assert.notInclude(summary, "deep-private-fixture");
  assert.include(summary, "additional validation failures omitted");
  assert.isBelow(Buffer.byteLength(summary), 4096);
});
