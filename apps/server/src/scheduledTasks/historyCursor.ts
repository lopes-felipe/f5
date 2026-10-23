import { Schema } from "effect";
import { IsoDateTime, TrimmedNonEmptyString } from "@t3tools/contracts";
const Cursor = Schema.Struct({ createdAt: IsoDateTime, id: TrimmedNonEmptyString });
export function encodeScheduledRunCursor(value: typeof Cursor.Type): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}
export function decodeScheduledRunCursor(value: string): typeof Cursor.Type {
  if (value.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(value))
    throw new Error("Invalid run-history cursor.");
  return Schema.decodeUnknownSync(Schema.fromJsonString(Cursor))(
    Buffer.from(value, "base64url").toString("utf8"),
  );
}
