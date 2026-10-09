import { Schema } from "effect";
const RuntimeConfigurationValues = Schema.Struct({
  model: Schema.optional(Schema.String),
  effort: Schema.optional(Schema.String),
  thinking: Schema.optional(Schema.String),
  fastMode: Schema.optional(Schema.String),
});
export const ProviderRuntimeInfo = Schema.Struct({
  requested: RuntimeConfigurationValues,
  effective: RuntimeConfigurationValues,
  fallback: Schema.optional(Schema.String),
});
export type ProviderRuntimeInfo = typeof ProviderRuntimeInfo.Type;
