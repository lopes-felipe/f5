import { Schema } from "effect";
import { NonNegativeInt } from "./baseSchemas";
import { ProviderKind } from "./providerKind";

/** Bump when a client must decode a new union variant or persisted state shape. */
export const F5_PROTOCOL_VERSION = 1;
export const F5_PROTOCOL_HEADER = "X-F5-Protocol";
export const F5_PROTOCOL_QUERY = "protocol";
export const F5_UPGRADE_REQUIRED_CLOSE_CODE = 4426;
export const F5_UPGRADE_REQUIRED_MESSAGE = "F5 was updated. Reload to continue.";

export const ProtocolUpgradeRequired = Schema.Struct({
  error: Schema.Literal("upgrade-required"),
  protocolVersion: NonNegativeInt,
});

export const ProviderSendLimits = Schema.Struct({
  maxInputChars: NonNegativeInt,
  maxImagesPerTurn: NonNegativeInt,
  maxImageBytes: NonNegativeInt,
  maxImageDataUrlChars: NonNegativeInt,
});
export type ProviderSendLimits = typeof ProviderSendLimits.Type;

export const ServerBootstrap = Schema.Struct({
  protocolVersion: NonNegativeInt,
  capabilities: Schema.Array(Schema.String),
  uploadLimits: Schema.Struct({
    attachments: Schema.Struct({ enabled: Schema.Boolean, maxFileBytes: NonNegativeInt }),
  }),
  sendLimits: ProviderSendLimits,
  providerSendLimits: Schema.Record(ProviderKind, ProviderSendLimits),
});
export type ServerBootstrap = typeof ServerBootstrap.Type;
