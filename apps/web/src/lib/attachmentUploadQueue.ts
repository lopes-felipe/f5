import { Schema } from "effect";
import {
  ATTACHMENT_CLIENT_UPLOAD_CONCURRENCY,
  F5_PROTOCOL_HEADER,
  F5_PROTOCOL_VERSION,
  AttachmentUpload,
  type ThreadId,
} from "@t3tools/contracts";
import {
  beginProtocolUpload,
  requireProtocolUpgrade,
  getServerAttachmentLimits,
} from "../protocolState";

interface UploadOptions {
  readonly signal?: AbortSignal;
  readonly onProgress?: (loaded: number, total: number) => void;
}
interface PendingUpload {
  run: () => Promise<void>;
}
export interface AttachmentUploadState {
  readonly progress: number;
  readonly status: "queued" | "uploading" | "complete" | "failed";
  readonly error?: string;
  readonly cancel: () => void;
}
const uploadStates = new WeakMap<File, AttachmentUploadState>();
const listeners = new Set<() => void>();
export const subscribeAttachmentUploads = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
export const getAttachmentUploadState = (file: File) => uploadStates.get(file);
function updateUpload(file: File, state: AttachmentUploadState) {
  uploadStates.set(file, state);
  for (const listener of listeners) listener();
}
export const attachmentSources = new WeakMap<File, "pasted-text" | "snapshot">();
export function setAttachmentSource(file: File, source: "pasted-text" | "snapshot"): File {
  attachmentSources.set(file, source);
  return file;
}
const pending: PendingUpload[] = [];
let active = 0;
const clientId = crypto.randomUUID();
/**
 * Never throws: `pump` runs after a job is queued and from `finally`, so a missing
 * bootstrap must not strand queued jobs or leak the protocol-upload guard. The
 * server enforces its own limits and rejects uploads when they are disabled.
 */
function clientUploadConcurrency(): number {
  try {
    return Math.max(1, getServerAttachmentLimits().clientConcurrency);
  } catch {
    return ATTACHMENT_CLIENT_UPLOAD_CONCURRENCY;
  }
}
function pump(): void {
  while (pending.length && active < clientUploadConcurrency()) {
    const next = pending.shift()!;
    active++;
    void next.run().finally(() => {
      active--;
      pump();
    });
  }
}
function abortError(): Error {
  return new DOMException("Upload cancelled", "AbortError");
}
function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    const abort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, milliseconds);
    signal?.addEventListener("abort", abort, { once: true });
  });
}

/** Queue lifetime is counted as an upload so protocol reload cannot lose queued files. */
export function uploadAttachment(
  baseUrl: string,
  threadId: ThreadId,
  file: File,
  options: UploadOptions = {},
): Promise<AttachmentUpload> {
  const finish = beginProtocolUpload();
  const controller = new AbortController();
  const signal = options.signal
    ? AbortSignal.any([options.signal, controller.signal])
    : controller.signal;
  options = { ...options, signal };
  const cancel = () => controller.abort();
  updateUpload(file, { progress: 0, status: "queued", cancel });
  return new Promise<AttachmentUpload>((resolve, reject) => {
    const job: PendingUpload = {
      run: async () => {
        try {
          updateUpload(file, { progress: 0, status: "uploading", cancel });
          for (let attempt = 0; ; attempt++) {
            if (options.signal?.aborted) throw abortError();
            const result = await new Promise<{ upload?: AttachmentUpload; retryAfter?: number }>(
              (done, fail) => {
                const xhr = new XMLHttpRequest();
                const abort = () => xhr.abort();
                const cleanup = () => options.signal?.removeEventListener("abort", abort);
                xhr.open(
                  "POST",
                  `${baseUrl.replace(/\/$/u, "")}/api/attachments/uploads?threadId=${encodeURIComponent(threadId)}${attachmentSources.has(file) ? `&source=${attachmentSources.get(file)}` : ""}`,
                );
                xhr.withCredentials = true;
                xhr.timeout = 10 * 60 * 1000;
                xhr.setRequestHeader(F5_PROTOCOL_HEADER, String(F5_PROTOCOL_VERSION));
                xhr.setRequestHeader("X-F5-File-Name", encodeURIComponent(file.name));
                xhr.setRequestHeader("X-F5-Upload-Client", clientId);
                xhr.setRequestHeader("Content-Type", file.type || "application/octet-stream");
                xhr.upload.onprogress = (event) => {
                  options.onProgress?.(event.loaded, event.total || file.size);
                  updateUpload(file, {
                    progress: Math.min(
                      99,
                      Math.round((event.loaded / (event.total || file.size)) * 100),
                    ),
                    status: "uploading",
                    cancel,
                  });
                };
                xhr.onerror = () => {
                  cleanup();
                  fail(new Error("Upload failed. Check the connection and retry."));
                };
                xhr.ontimeout = () => {
                  cleanup();
                  fail(new Error("Upload timed out. Retry the file."));
                };
                xhr.onabort = () => {
                  cleanup();
                  fail(abortError());
                };
                xhr.onload = () => {
                  cleanup();
                  if (xhr.status === 429 && attempt < 5) {
                    const seconds = Number(xhr.getResponseHeader("Retry-After"));
                    done({
                      retryAfter: Math.min(
                        30_000,
                        Math.max(1000, Number.isFinite(seconds) ? seconds * 1000 : 2000),
                      ),
                    });
                    return;
                  }
                  if (xhr.status === 426) requireProtocolUpgrade();
                  try {
                    const body = JSON.parse(xhr.responseText) as AttachmentUpload & {
                      error?: string;
                    };
                    if (xhr.status !== 201)
                      throw new Error(body.error || `Upload failed (${xhr.status}).`);
                    if (!body.uploadId || !body.contentHash)
                      throw new Error("Invalid upload response.");
                    done({ upload: Schema.decodeUnknownSync(AttachmentUpload)(body) });
                  } catch (error) {
                    fail(error);
                  }
                };
                options.signal?.addEventListener("abort", abort, { once: true });
                if (options.signal?.aborted) {
                  cleanup();
                  fail(abortError());
                  return;
                }
                xhr.send(file);
              },
            );
            if (result.upload) {
              updateUpload(file, { progress: 100, status: "complete", cancel });
              resolve(result.upload);
              return;
            }
            await delay(result.retryAfter ?? 2000, options.signal);
          }
        } catch (error) {
          updateUpload(file, {
            progress: 0,
            status: "failed",
            error: error instanceof Error ? error.message : "Upload failed",
            cancel,
          });
          reject(error);
        } finally {
          signal.removeEventListener("abort", abortQueued);
          finish();
        }
      },
    };
    const abortQueued = () => {
      const index = pending.indexOf(job);
      if (index < 0) return;
      pending.splice(index, 1);
      updateUpload(file, { progress: 0, status: "failed", error: "Upload cancelled", cancel });
      finish();
      reject(abortError());
    };
    pending.push(job);
    signal.addEventListener("abort", abortQueued, { once: true });
    if (signal.aborted) abortQueued();
    pump();
  });
}
