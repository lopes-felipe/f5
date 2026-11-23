import * as Schema from "effect/Schema";
import * as Generated from "./_generated/schema.gen";
import { JsonUnknown } from "./_internal/jsonUnknown";

// Session notices postdate the generated ACP schema. Keep wire extensions here
// so regenerating the protocol does not silently remove support.
export const NoticeUpdate = Schema.Struct({
  sessionUpdate: Schema.Literal("notice"),
  severity: Schema.String,
  title: Schema.NonEmptyString,
  description: Schema.optionalKey(Schema.NullOr(Schema.String)),
  _meta: Schema.optionalKey(Schema.NullOr(Schema.Record(Schema.String, JsonUnknown))),
});
export const SessionNotification = Schema.Struct({
  sessionId: Schema.String,
  update: Schema.Union([Generated.SessionUpdate, NoticeUpdate]),
  _meta: Schema.optionalKey(Schema.NullOr(Schema.Record(Schema.String, JsonUnknown))),
});
export type SessionNotification = typeof SessionNotification.Type;

export const ClientCapabilities = Generated.ClientCapabilities.pipe(
  Schema.fieldsAssign({
    session: Schema.optionalKey(
      Schema.NullOr(Schema.Struct({ notices: Schema.optionalKey(Schema.Struct({})) })),
    ),
  }),
);
export type ClientCapabilities = typeof ClientCapabilities.Type;
export const InitializeRequest = Generated.InitializeRequest.pipe(
  Schema.fieldsAssign({ clientCapabilities: Schema.optionalKey(ClientCapabilities) }),
);
export type InitializeRequest = typeof InitializeRequest.Type;
