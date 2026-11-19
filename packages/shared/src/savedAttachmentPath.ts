const SAVED_ATTACHMENT_FILE =
  /\/attachments\/([^/]+-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[a-z0-9]+)$/iu;

/**
 * Returns the opaque attachment filename of an absolute, `/`-separated path into the
 * attachment store, or undefined for any other path. The server writes these paths into
 * conversation Markdown (for example `image_publish`), and the chat resolves them to the
 * attachment asset capability; only opaque ids qualify, and the server still confines reads.
 */
export function savedAttachmentFilename(absolutePath: string): string | undefined {
  return SAVED_ATTACHMENT_FILE.exec(absolutePath)?.[1];
}
