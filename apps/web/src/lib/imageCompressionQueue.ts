import type { ComposerImageProcessor, CompressComposerImageResult } from "./imageCompression";

// The shared conversion slots live apart from the compressor so the composer can
// reserve a slot synchronously while the compressor itself loads on first use.
const conversionQueue: Array<() => void> = [];
let activeConversions = 0;

/** Bound both worker count and waiting work across all composers. */
export function processComposerImageBounded(
  processor: ComposerImageProcessor,
  file: File,
  signal: AbortSignal,
): Promise<CompressComposerImageResult> {
  return processComposerImageTaskBounded(() => processor(file, { signal }), signal);
}

/** Keep source fetching inside the same budget as decoding to bound retained bytes. */
export function processComposerImageTaskBounded(
  task: () => Promise<CompressComposerImageResult>,
  signal: AbortSignal,
): Promise<CompressComposerImageResult> {
  if (signal.aborted) return Promise.resolve({ ok: false, reason: "cancelled" });
  if (conversionQueue.length >= 100) return Promise.resolve({ ok: false, reason: "busy" });
  return new Promise((resolve) => {
    const run = () => {
      signal.removeEventListener("abort", abort);
      if (signal.aborted) {
        resolve({ ok: false, reason: "cancelled" });
        return;
      }
      activeConversions++;
      // Start synchronously, but route a synchronous throw through the chain so
      // the slot is always released and the queue keeps moving.
      let conversion: Promise<CompressComposerImageResult>;
      try {
        conversion = task();
      } catch (error) {
        conversion = Promise.reject(error);
      }
      void conversion
        .then(resolve, () => resolve({ ok: false, reason: "unreadable" }))
        .finally(() => {
          activeConversions--;
          while (activeConversions < 2 && conversionQueue.length) conversionQueue.shift()!();
        });
    };
    const abort = () => {
      const index = conversionQueue.indexOf(run);
      if (index >= 0) {
        conversionQueue.splice(index, 1);
        resolve({ ok: false, reason: "cancelled" });
      }
    };
    if (activeConversions < 2) run();
    else {
      conversionQueue.push(run);
      signal.addEventListener("abort", abort, { once: true });
    }
  });
}
