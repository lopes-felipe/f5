import {
  F5_PROTOCOL_VERSION,
  KNOWN_PROVIDER_KINDS,
  type ServerBootstrap,
} from "@t3tools/contracts";

const limits = {
  maxInputChars: 120_000,
  maxImagesPerTurn: 8,
  maxImageBytes: 10 * 1024 * 1024,
  maxImageDataUrlChars: 14_000_000,
};
export const serverBootstrapFixture: ServerBootstrap = {
  protocolVersion: F5_PROTOCOL_VERSION,
  capabilities: ["image-attachments"],
  uploadLimits: { attachments: { enabled: false, maxFileBytes: 0 } },
  sendLimits: limits,
  providerSendLimits: Object.fromEntries(
    KNOWN_PROVIDER_KINDS.map((kind) => [kind, limits]),
  ) as ServerBootstrap["providerSendLimits"],
};
