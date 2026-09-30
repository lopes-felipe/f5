import { Schema } from "effect";
import { ThreadId, TrimmedNonEmptyString } from "./baseSchemas";

export const ATTACHMENT_MAX_COUNT = 100;
export const ATTACHMENT_MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const ATTACHMENT_MAX_IMAGES_BYTES = 80 * 1024 * 1024;
export const ATTACHMENT_MAX_FILE_BYTES = 50 * 1024 * 1024;
export const ATTACHMENT_MAX_TURN_BYTES = 256 * 1024 * 1024;
export const ATTACHMENT_DRAFT_QUOTA_BYTES = 1024 * 1024 * 1024;
export const ATTACHMENT_PROFILE_QUOTA_BYTES = 2 * 1024 * 1024 * 1024;
export const ATTACHMENT_CLIENT_UPLOAD_CONCURRENCY = 2;
export const ATTACHMENT_SERVER_UPLOAD_CONCURRENCY = 4;

export const UploadId = Schema.String.check(Schema.isPattern(/^[a-f0-9-]{36}$/u));
export const UploadedAttachmentRef = Schema.Struct({
  type: Schema.Literal("upload"),
  uploadId: UploadId,
});
export type UploadedAttachmentRef = typeof UploadedAttachmentRef.Type;
export const AttachmentUpload = Schema.Struct({
  uploadId: UploadId,
  draftThreadId: ThreadId,
  kind: Schema.Literals(["image", "file"]),
  name: TrimmedNonEmptyString,
  mimeType: TrimmedNonEmptyString,
  sizeBytes: Schema.Number,
  contentHash: Schema.String,
  expiresAt: Schema.String,
  source: Schema.optional(Schema.Literals(["pasted-text", "snapshot"])),
});
export type AttachmentUpload = typeof AttachmentUpload.Type;
export const AttachmentUploadsInput = Schema.Struct({
  threadId: ThreadId,
  uploadIds: Schema.Array(UploadId).check(Schema.isMaxLength(100)),
});
export type AttachmentUploadsInput = typeof AttachmentUploadsInput.Type;
export const AttachmentCloneToUploadInput = Schema.Struct({
  threadId: ThreadId,
  source: Schema.Union([
    Schema.Struct({ attachmentId: TrimmedNonEmptyString }),
    Schema.Struct({ uploadId: UploadId }),
  ]),
});
export type AttachmentCloneToUploadInput = typeof AttachmentCloneToUploadInput.Type;
