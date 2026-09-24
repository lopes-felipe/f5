import {
  F5_PROTOCOL_VERSION,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  PROVIDER_SEND_TURN_MAX_IMAGE_DATA_URL_CHARS,
  PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
  type ServerBootstrap,
} from "@t3tools/contracts";

const sendLimits = {
  maxInputChars: PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
  maxImagesPerTurn: PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  maxImageBytes: PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  maxImageDataUrlChars: PROVIDER_SEND_TURN_MAX_IMAGE_DATA_URL_CHARS,
};

export const SERVER_BOOTSTRAP: ServerBootstrap = {
  protocolVersion: F5_PROTOCOL_VERSION,
  capabilities: ["image-attachments"],
  // Generic uploads do not exist yet. Advertise only implemented functionality.
  uploadLimits: { attachments: { enabled: false, maxFileBytes: 0 } },
  sendLimits,
};

export const UPGRADE_REQUIRED = {
  error: "upgrade-required",
  protocolVersion: F5_PROTOCOL_VERSION,
} as const;
export const protocolMatches = (value: unknown): boolean => value === String(F5_PROTOCOL_VERSION);
