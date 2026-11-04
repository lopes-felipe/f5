import type { FileHandle } from "node:fs/promises";

export interface JsonlLine {
  text: string | null;
  startOffset: number;
  endOffset: number;
  terminated: boolean;
}
/**
 * Stop at record boundaries after the scan budget. An oversized record already
 * in progress is finished without retaining its bytes, so no cursor can stall
 * permanently inside it. Cancellation is checked between every 64 KiB read.
 */
export async function* readBoundedJsonlLines(
  file: FileHandle,
  options: {
    start: number;
    dir: "fwd" | "back";
    maxLineBytes: number;
    maxScanBytes?: number;
    signal?: AbortSignal;
  },
): AsyncGenerator<JsonlLine> {
  const size = (await file.stat()).size;
  let position = options.start,
    scanned = 0;
  let parts: Buffer[] = [],
    length = 0;
  let boundary = position;
  const append = (part: Buffer, prepend = false) => {
    length += part.length;
    if (length <= options.maxLineBytes) {
      if (prepend) parts.unshift(part);
      else parts.push(part);
    } else parts = [];
  };
  const value = () =>
    length > options.maxLineBytes ? null : Buffer.concat(parts).toString("utf8");
  if (options.dir === "fwd") {
    while (
      position < size &&
      (scanned < (options.maxScanBytes ?? 8 * 1024 * 1024) || length > options.maxLineBytes)
    ) {
      options.signal?.throwIfAborted();
      const buffer = Buffer.alloc(Math.min(65536, size - position));
      const { bytesRead } = await file.read(buffer, 0, buffer.length, position);
      if (!bytesRead) break;
      scanned += bytesRead;
      let from = 0;
      for (let i = buffer.indexOf(10); i >= 0 && i < bytesRead; i = buffer.indexOf(10, from)) {
        append(buffer.subarray(from, i));
        const end = position + i + 1;
        yield { text: value(), startOffset: boundary, endOffset: end, terminated: true };
        if (scanned >= (options.maxScanBytes ?? 8 * 1024 * 1024)) return;
        boundary = end;
        parts = [];
        length = 0;
        from = i + 1;
      }
      append(buffer.subarray(from, bytesRead));
      position += bytesRead;
    }
    if (length && position === size)
      yield { text: value(), startOffset: boundary, endOffset: position, terminated: false };
  } else {
    // A backward page starts at a record boundary or EOF.
    let terminated = false;
    while (
      position > 0 &&
      (scanned < (options.maxScanBytes ?? 8 * 1024 * 1024) || length > options.maxLineBytes)
    ) {
      options.signal?.throwIfAborted();
      const start = Math.max(0, position - 65536);
      const buffer = Buffer.alloc(position - start);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, start);
      if (!bytesRead) break;
      scanned += bytesRead;
      let end = bytesRead;
      for (
        let i = buffer.lastIndexOf(10, bytesRead - 1);
        i >= 0;
        i = end > 0 ? buffer.lastIndexOf(10, end - 1) : -1
      ) {
        if (start + i + 1 === boundary && length === 0) {
          terminated = true;
          end = i;
          continue;
        }
        append(buffer.subarray(i + 1, end), true);
        yield { text: value(), startOffset: start + i + 1, endOffset: boundary, terminated };
        if (scanned >= (options.maxScanBytes ?? 8 * 1024 * 1024)) return;
        boundary = start + i + 1;
        parts = [];
        length = 0;
        terminated = true;
        end = i;
        if (end === 0) break;
      }
      append(buffer.subarray(0, end), true);
      position = start;
    }
    if (position === 0 && boundary > 0)
      yield { text: value(), startOffset: 0, endOffset: boundary, terminated };
  }
}
