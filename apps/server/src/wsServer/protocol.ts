import { updateBootstrapOutcome } from "../distribution/activation";
import {
  ATTACHMENT_MAX_COUNT,
  ATTACHMENT_MAX_IMAGE_BYTES,
  ATTACHMENT_MAX_IMAGES_BYTES,
  ATTACHMENT_MAX_FILE_BYTES,
  ATTACHMENT_MAX_TURN_BYTES,
  ATTACHMENT_CLIENT_UPLOAD_CONCURRENCY,
  ATTACHMENT_SERVER_UPLOAD_CONCURRENCY,
  ATTACHMENT_DRAFT_QUOTA_BYTES,
  ATTACHMENT_PROFILE_QUOTA_BYTES,
} from "@t3tools/contracts";
import { providerMaxImages, providerMaxAttachmentBytes } from "@t3tools/shared/attachmentLimits";
import { KNOWN_PROVIDER_KINDS } from "@t3tools/contracts";
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
  maxAttachmentBytes: ATTACHMENT_MAX_TURN_BYTES,
  maxFileBytes: ATTACHMENT_MAX_FILE_BYTES,
  maxImagesPerTurn: PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  maxImageBytes: PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  maxImageDataUrlChars: PROVIDER_SEND_TURN_MAX_IMAGE_DATA_URL_CHARS,
};

export const SERVER_BOOTSTRAP: ServerBootstrap = {
  protocolVersion: F5_PROTOCOL_VERSION,
  ...(updateBootstrapOutcome() ? { update: updateBootstrapOutcome() } : {}),
  capabilities: [
    "image-attachments",
    "custom-model-metadata",
    "assistant-quotes",
    "repository-issue-links",
    // On by default. The two open transport/retained-heap gates fail identically
    // without the redesign (docs/reviews/phase-ten-composer-validation.md).
    // `F5_COMPOSER_REDESIGN=0` omits the capability and keeps the legacy layout.
    ...(process.env.F5_COMPOSER_REDESIGN === "0" ? [] : ["composer-redesign"]),
  ],
  uploadLimits: { attachments: { enabled: true, maxFileBytes: ATTACHMENT_MAX_FILE_BYTES } },
  providerSendLimits: Object.fromEntries(
    KNOWN_PROVIDER_KINDS.map((provider) => [
      provider,
      {
        ...sendLimits,
        maxImagesPerTurn: providerMaxImages(provider),
        maxAttachmentBytes: providerMaxAttachmentBytes(provider),
      },
    ]),
  ),
  attachmentLimits: {
    maxCount: ATTACHMENT_MAX_COUNT,
    maxImageBytes: ATTACHMENT_MAX_IMAGE_BYTES,
    maxImagesBytes: ATTACHMENT_MAX_IMAGES_BYTES,
    maxFileBytes: ATTACHMENT_MAX_FILE_BYTES,
    maxTotalBytes: ATTACHMENT_MAX_TURN_BYTES,
    clientConcurrency: ATTACHMENT_CLIENT_UPLOAD_CONCURRENCY,
    serverConcurrency: ATTACHMENT_SERVER_UPLOAD_CONCURRENCY,
    draftQuotaBytes: ATTACHMENT_DRAFT_QUOTA_BYTES,
    profileQuotaBytes: ATTACHMENT_PROFILE_QUOTA_BYTES,
  },
  sendLimits,
};

export const UPGRADE_REQUIRED = {
  error: "upgrade-required",
  protocolVersion: F5_PROTOCOL_VERSION,
} as const;
export const protocolMatches = (value: unknown): boolean => value === String(F5_PROTOCOL_VERSION);
