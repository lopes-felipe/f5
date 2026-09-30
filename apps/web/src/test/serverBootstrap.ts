import { F5_PROTOCOL_VERSION, type ServerBootstrap } from "@t3tools/contracts";

const limits = {
  maxInputChars: 120_000,
  maxImagesPerTurn: 100,
  maxImageBytes: 10 * 1024 * 1024,
  maxImageDataUrlChars: 14_000_000,
};
export const serverBootstrapFixture: ServerBootstrap = {
  protocolVersion: F5_PROTOCOL_VERSION,
  capabilities: ["image-attachments"],
  uploadLimits: { attachments: { enabled: true, maxFileBytes: 50 * 1024 * 1024 } },
  attachmentLimits: {
    maxCount: 100,
    maxImageBytes: 10 * 1024 * 1024,
    maxImagesBytes: 80 * 1024 * 1024,
    maxFileBytes: 50 * 1024 * 1024,
    maxTotalBytes: 256 * 1024 * 1024,
    clientConcurrency: 2,
    serverConcurrency: 4,
    draftQuotaBytes: 1024 * 1024 * 1024,
    profileQuotaBytes: 2 * 1024 * 1024 * 1024,
  },
  sendLimits: limits,
};
