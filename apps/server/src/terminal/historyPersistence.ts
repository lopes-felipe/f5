import fs from "node:fs";
import { BoundedTerminalHistory, TERMINAL_HISTORY_MAX_BYTES } from "./BoundedTerminalHistory";

/** Read only a bounded tail, with enough overlap to retain a complete UTF-8 suffix. */
export async function readTerminalHistory(file: string, maxLines: number) {
  const history = new BoundedTerminalHistory(maxLines);
  const handle = await fs.promises.open(file, "r");
  let size: number;
  let bytesRead = 0;
  let start: number;
  try {
    size = (await handle.stat()).size;
    start = Math.max(0, size - TERMINAL_HISTORY_MAX_BYTES - 4);
    const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, size - start));
    const decoder = new TextDecoder("utf-8", { ignoreBOM: true });
    let first = true;
    while (start + bytesRead < size) {
      const result = await handle.read(
        buffer,
        0,
        Math.min(buffer.length, size - start - bytesRead),
        start + bytesRead,
      );
      if (!result.bytesRead) break;
      bytesRead += result.bytesRead;
      let offset = 0;
      // Ignore continuation bytes only at a truncated file-tail boundary.
      if (first && start > 0) {
        while (offset < result.bytesRead && (buffer[offset]! & 0xc0) === 0x80) offset++;
        // A short read can consist entirely of continuation bytes.
        first = offset === result.bytesRead;
      } else first = false;
      history.append(decoder.decode(buffer.subarray(offset, result.bytesRead), { stream: true }));
    }
    history.append(decoder.decode());
    history.finish();
  } finally {
    await handle.close();
  }
  return { history, truncated: start > 0 || history.byteLength !== bytesRead };
}
