import type { NativeImage, Rectangle, WebContents } from "electron";

interface CaptureJob {
  start: () => void;
  reject: (reason: Error) => void;
}
interface CaptureQueue {
  active: CaptureJob | null;
  waiting: CaptureJob[];
  released: boolean;
  needsReload: boolean;
}
const captureQueues = new WeakMap<WebContents, CaptureQueue>();

/** Retiring a tab must drop requests that have not yet reached Chromium. */
export function releasePreviewCaptures(guest: WebContents): void {
  const queue = captureQueues.get(guest);
  if (!queue) return;
  queue.released = true;
  const jobs = [...(queue.active ? [queue.active] : []), ...queue.waiting];
  queue.waiting = [];
  for (const job of jobs)
    job.reject(new Error("Preview connection closed during screenshot capture."));
}

/** A caller timeout does not cancel Chromium's capture; keep its slot until it actually ends. */
function captureSerially(guest: WebContents, rect: Rectangle | undefined, timeoutMs: number) {
  let queue = captureQueues.get(guest);
  if (!queue) {
    queue = { active: null, waiting: [], released: false, needsReload: false };
    captureQueues.set(guest, queue);
    const current = queue;
    const invalidate = () => {
      const jobs = [...(current.active ? [current.active] : []), ...current.waiting];
      current.active = null;
      current.waiting = [];
      current.needsReload = false;
      for (const job of jobs) job.reject(new Error("Preview changed during screenshot capture."));
    };
    // A new document releases a capture that Chromium may never answer. Renderer loss alone
    // does not: wait for the new document before allowing another native capture.
    guest.on("did-navigate", invalidate);
    guest.once("destroyed", invalidate);
    // Never overlap a possibly live native capture. A stalled renderer needs a
    // new document before screenshots can safely resume.
    const requireReload = () => {
      current.needsReload = true;
      const jobs = [...(current.active ? [current.active] : []), ...current.waiting];
      current.waiting = [];
      for (const job of jobs)
        job.reject(
          new Error("Preview screenshot stalled. Reload the preview to resume screenshots."),
        );
    };
    guest.on("render-process-gone", requireReload);
    guest.on("unresponsive", requireReload);
  }
  const current = queue;
  return new Promise<NativeImage>((resolve, reject) => {
    let settled = false;
    const finish = (result: NativeImage | Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (result instanceof Error) reject(result);
      else resolve(result);
    };
    const next = () => {
      if (current.active !== job) return;
      current.active = null;
      current.needsReload = false;
      current.waiting.shift()?.start();
    };
    const job: CaptureJob = {
      reject: (error) => finish(error),
      start: () => {
        current.active = job;
        if (settled || current.released || guest.isDestroyed()) {
          finish(new Error("Preview closed during screenshot capture."));
          next();
          return;
        }
        Promise.resolve()
          .then(() => {
            if (current.active !== job || settled)
              throw new Error("Preview changed before screenshot capture.");
            return guest.capturePage(rect);
          })
          .then(
            (image) => {
              finish(image);
              next();
            },
            (error: unknown) => {
              finish(error instanceof Error ? error : new Error(String(error)));
              next();
            },
          );
      },
    };
    const timer = setTimeout(() => {
      if (current.active === job) current.needsReload = true;
      finish(
        new Error(
          "Preview screenshot timed out. Reload the preview if screenshots remain stalled.",
        ),
      );
      // Timed-out queued work must never reach a later page or owner.
      const index = current.waiting.indexOf(job);
      if (index >= 0) current.waiting.splice(index, 1);
    }, timeoutMs);
    timer.unref?.();
    if (current.released)
      job.reject(new Error("Preview connection closed during screenshot capture."));
    else if (current.needsReload)
      job.reject(
        new Error("Preview screenshot stalled. Reload the preview to resume screenshots."),
      );
    else if (current.active) current.waiting.push(job);
    else job.start();
  });
}

export async function captureBoundedPage(
  guest: WebContents,
  rect?: Rectangle,
  timeoutMs = 10_000,
): Promise<NativeImage> {
  const image = await captureSerially(guest, rect, timeoutMs);
  if (guest.isDestroyed()) throw new Error("Preview closed during screenshot capture.");
  const size = image.getSize();
  if (!size.width || !size.height) throw new Error("Preview screenshot is empty.");
  const bounded =
    Math.max(size.width, size.height) > 2560
      ? image.resize(size.width >= size.height ? { width: 2560 } : { height: 2560 })
      : image;
  if (bounded.toPNG().length > 25 * 1024 * 1024)
    throw new Error("Preview screenshot exceeds the size limit.");
  return bounded;
}
