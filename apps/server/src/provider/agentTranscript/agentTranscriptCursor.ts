import { Schema } from "effect";

const Offset = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
);
// Keep safe numeric identities readable for tabs opened before this change.
// New cursors use exact decimal strings, including NTFS ids above 2^53.
const FileIdentity = Schema.Union([
  Offset,
  Schema.String.check(Schema.isPattern(/^(0|[1-9][0-9]{0,31})$/)),
]);
const Cursor = Schema.Union([
  Schema.Struct({
    v: Schema.Literal(1),
    p: Schema.Literal("claude"),
    dir: Schema.Literals(["fwd", "back"]),
    o: Offset,
    ino: FileIdentity,
    dev: FileIdentity,
  }),
  Schema.Struct({
    v: Schema.Literal(1),
    p: Schema.Literal("codex"),
    c: Schema.NullOr(Schema.String),
    floor: Schema.NullOr(Schema.String),
    i: Schema.optional(Offset),
    fi: Schema.optional(Offset),
  }),
]);
export type TranscriptCursor = typeof Cursor.Type;
export function encodeCursor(cursor: TranscriptCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}
export function decodeCursor(value: string): TranscriptCursor {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("Invalid transcript cursor.");
  const raw: unknown = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  const decoded = Schema.decodeUnknownSync(Cursor)(raw);
  const keys =
    decoded.p === "claude"
      ? ["v", "p", "dir", "o", "ino", "dev"]
      : ["v", "p", "c", "floor", "i", "fi"];
  if (Object.keys(raw as object).some((key) => !keys.includes(key)))
    throw new Error("Invalid transcript cursor.");
  return decoded;
}
