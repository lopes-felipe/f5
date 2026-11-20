/**
 * Length-prefixed JSON frames for a backend channel carried over plain byte streams, such as
 * the stdio of the `limactl shell` process main spawns for a Linux VM profile. Each frame is
 * a 4-byte big-endian payload length followed by that many bytes of UTF-8 JSON.
 *
 * Both ends use this codec. Inherited Node IPC is not available across a VM boundary, and a
 * listening socket would let any guest process claim to be the backend; a stream main owns
 * keeps the channel an unforgeable capability.
 */

/** Large enough for screenshots in computer responses, small enough to bound main's memory. */
export const BACKEND_FRAME_MAX_BYTES = 32 * 1024 * 1024;

export class BackendFrameError extends Error {
  override readonly name = "BackendFrameError";
}

export function encodeBackendFrame(message: unknown): Uint8Array {
  const json = JSON.stringify(message);
  if (json === undefined) throw new BackendFrameError("Frame payload is not serializable.");
  const payload = new TextEncoder().encode(json);
  if (payload.byteLength > BACKEND_FRAME_MAX_BYTES)
    throw new BackendFrameError("Frame payload exceeds the maximum size.");
  const frame = new Uint8Array(4 + payload.byteLength);
  new DataView(frame.buffer).setUint32(0, payload.byteLength, false);
  frame.set(payload, 4);
  return frame;
}

/**
 * Incremental decoder. `push` returns every complete message so far. Any malformed frame
 * (oversized, invalid UTF-8 or JSON) throws, and the decoder stays failed: the caller must
 * close the channel rather than try to resynchronize a stream it can no longer trust.
 */
export class BackendFrameDecoder {
  /**
   * Unconsumed input, kept as received. Bytes are copied only once a whole frame has
   * arrived, so a large frame split into many chunks costs linear, not quadratic, copying.
   */
  private chunks: Uint8Array[] = [];
  /** Bytes of `chunks[0]` already consumed. */
  private headOffset = 0;
  private size = 0;
  private failed = false;
  private readonly utf8 = new TextDecoder("utf-8", { fatal: true });

  constructor(private readonly maxBytes = BACKEND_FRAME_MAX_BYTES) {}

  push(chunk: Uint8Array): unknown[] {
    if (this.failed) throw new BackendFrameError("Decoder already failed.");
    if (chunk.byteLength > 0) {
      this.chunks.push(chunk);
      this.size += chunk.byteLength;
    }
    const messages: unknown[] = [];
    try {
      while (this.size >= 4) {
        const header = this.peek(4);
        const length = new DataView(header.buffer, header.byteOffset, 4).getUint32(0, false);
        if (length > this.maxBytes)
          throw new BackendFrameError("Frame payload exceeds the maximum size.");
        if (this.size - 4 < length) break;
        this.take(4);
        const payload = this.take(length);
        let text: string;
        try {
          text = this.utf8.decode(payload);
        } catch {
          throw new BackendFrameError("Frame payload is not valid UTF-8.");
        }
        try {
          messages.push(JSON.parse(text));
        } catch {
          throw new BackendFrameError("Frame payload is not valid JSON.");
        }
      }
    } catch (error) {
      this.failed = true;
      this.chunks = [];
      this.headOffset = 0;
      this.size = 0;
      throw error;
    }
    return messages;
  }

  /** Bytes of an incomplete trailing frame; a non-zero value at end of stream is truncation. */
  get pendingBytes(): number {
    return this.size;
  }

  /** The first `count` buffered bytes, without consuming them. */
  private peek(count: number): Uint8Array {
    const first = this.chunks[0]!;
    if (first.byteLength - this.headOffset >= count)
      return first.subarray(this.headOffset, this.headOffset + count);
    return this.gather(count, false);
  }

  /** Removes and returns the first `count` buffered bytes. */
  private take(count: number): Uint8Array {
    if (count === 0) return new Uint8Array(0);
    const first = this.chunks[0]!;
    if (first.byteLength - this.headOffset >= count) {
      const bytes = first.subarray(this.headOffset, this.headOffset + count);
      this.advance(count);
      return bytes;
    }
    return this.gather(count, true);
  }

  private gather(count: number, consume: boolean): Uint8Array {
    const out = new Uint8Array(count);
    let written = 0;
    let index = 0;
    let offset = this.headOffset;
    while (written < count) {
      const chunk = this.chunks[index]!;
      const slice = chunk.subarray(offset, offset + Math.min(count - written, chunk.byteLength - offset));
      out.set(slice, written);
      written += slice.byteLength;
      index++;
      offset = 0;
    }
    if (consume) this.advance(count);
    return out;
  }

  private advance(count: number): void {
    this.size -= count;
    let remaining = count;
    while (remaining > 0) {
      const available = this.chunks[0]!.byteLength - this.headOffset;
      if (remaining < available) {
        this.headOffset += remaining;
        return;
      }
      remaining -= available;
      this.chunks.shift();
      this.headOffset = 0;
    }
  }
}
