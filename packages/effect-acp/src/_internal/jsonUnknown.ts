import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";

/**
 * `Schema.Unknown` that crosses the wire unchanged.
 *
 * Effect's RPC layer encodes and decodes payloads through `Schema.toCodecJson`, which turns a
 * bare `Schema.Unknown` into `null`: encoding drops the value and decoding rejects anything but
 * `null`. ACP fields such as `toolCall.rawInput` carry arbitrary JSON, so they use this instead.
 */
export const JsonUnknown = Schema.Unknown.annotate({
  toCodecJson: () => Schema.link<unknown>()(Schema.Any, SchemaTransformation.passthrough()),
});
