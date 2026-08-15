import { processImageForComposerInWorker } from "./imageCompression.core";

interface ImageCompressionWorkerRequest {
  readonly id: string;
  readonly file: Blob;
  readonly mimeType: string;
  readonly maxBytes: number;
  readonly maxDataUrlChars: number;
}

self.addEventListener("message", (event: MessageEvent<ImageCompressionWorkerRequest>) => {
  const request = event.data;
  void processImageForComposerInWorker(request).then(
    (result) => self.postMessage({ id: request.id, result }),
    () =>
      self.postMessage({
        id: request.id,
        result: { ok: false, reason: "unreadable" },
      }),
  );
});
