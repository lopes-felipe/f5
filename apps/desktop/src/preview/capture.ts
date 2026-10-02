import type { NativeImage, Rectangle, WebContents } from "electron";
export async function captureBoundedPage(
  guest: WebContents,
  rect?: Rectangle,
  timeoutMs = 10_000,
): Promise<NativeImage> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const image = await Promise.race([
    guest.capturePage(rect),
    new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error("Preview screenshot timed out. Retry after the page responds.")),
        timeoutMs,
      );
      timer.unref?.();
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
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
