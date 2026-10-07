import { Schema } from "effect";
import { IsoDateTime } from "./baseSchemas";

export const RuntimeUsageLimitWindow = Schema.Struct({
  id: Schema.String,
  label: Schema.NullOr(Schema.String),
  resetsAt: Schema.NullOr(IsoDateTime),
});
export type RuntimeUsageLimitWindow = typeof RuntimeUsageLimitWindow.Type;

export const RuntimeUsageLimit = Schema.Struct({
  windows: Schema.Array(RuntimeUsageLimitWindow),
  resetsAt: Schema.NullOr(IsoDateTime),
  resetSource: Schema.NullOr(Schema.Literals(["provider", "account", "message"])),
  evidence: Schema.Literals(["typed", "message"]),
});
export type RuntimeUsageLimit = typeof RuntimeUsageLimit.Type;
