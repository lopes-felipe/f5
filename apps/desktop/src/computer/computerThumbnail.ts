import type { ComputerScreenshot } from "@t3tools/contracts";
import { nativeImage } from "electron";

/** Shared by production activity rendering and the native performance harness. */
export function computerScreenshotThumbnail(screenshot: ComputerScreenshot): string | undefined {
  const image = nativeImage.createFromDataURL(
    "data:" + screenshot.mimeType + ";base64," + screenshot.data,
  );
  if (image.isEmpty()) return undefined;
  const bytes = image.resize({ width: 320 }).toJPEG(50);
  const data = "data:image/jpeg;base64," + bytes.toString("base64");
  return Buffer.byteLength(data) <= 40 * 1024 ? data : undefined;
}
