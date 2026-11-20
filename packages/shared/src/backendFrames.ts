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
  private buffered: Uint8Array = new Uint8Array(0);
  private failed = false;
  private readonly utf8 = new TextDecoder("utf-8", { fatal: true });

  constructor(private readonly maxBytes = BACKEND_FRAME_MAX_BYTES) {}

  push(chunk: Uint8Array): unknown[] {
    if (this.failed) throw new BackendFrameError("Decoder already failed.");
    const joined = new Uint8Array(this.buffered.byteLength + chunk.byteLength);
    joined.set(this.buffered, 0);
    joined.set(chunk, this.buffered.byteLength);
    const view = new DataView(joined.buffer, joined.byteOffset, joined.byteLength);
    const messages: unknown[] = [];
    let offset = 0;
    try {
      while (joined.byteLength - offset >= 4) {
        const length = view.getUint32(offset, false);
        if (length > this.maxBytes)
          throw new BackendFrameError("Frame payload exceeds the maximum size.");
        if (joined.byteLength - offset - 4 < length) break;
        const payload = joined.subarray(offset + 4, offset + 4 + length);
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
        offset += 4 + length;
      }
    } catch (error) {
      this.failed = true;
      this.buffered = new Uint8Array(0);
      throw error;
    }
    this.buffered = joined.slice(offset);
    return messages;
  }

  /** Bytes of an incomplete trailing frame; a non-zero value at end of stream is truncation. */
  get pendingBytes(): number {
    return this.buffered.byteLength;
  }
}
