import { EventEmitter } from "node:events";
import * as Net from "node:net";
import type { Readable, Writable } from "node:stream";
import {
  BACKEND_FRAME_MAX_BYTES,
  BackendFrameDecoder,
  encodeBackendFrame,
} from "@t3tools/shared/backendFrames";
import type { ComputerIpcProcess } from "./DesktopComputerHost";
import { claimGuestFrameFds } from "./guestFrameFds";

/** Output the backend may queue for a desktop that isn't reading: two maximum-size frames. */
export const FRAME_CHANNEL_MAX_PENDING_BYTES = 2 * BACKEND_FRAME_MAX_BYTES;

/**
 * A guest backend's end of its desktop channel: length-prefixed JSON frames over two byte
 * streams, presented with the same shape as inherited Node IPC. The guest launcher puts
 * main's frames on fd 3 and takes the backend's from fd 4, and points stdout at stderr, so
 * nothing the backend or its children print can corrupt the stream.
 *
 * Malformed input, end of stream, a write failure or a desktop that stops reading (more
 * than `maxPendingBytes` queued) disconnects; nothing resynchronizes.
 */
export function frameStreamIpc(
  input: Readable,
  output: Writable,
  maxPendingBytes = FRAME_CHANNEL_MAX_PENDING_BYTES,
): ComputerIpcProcess {
  const events = new EventEmitter();
  const decoder = new BackendFrameDecoder();
  let connected = true;
  const disconnect = () => {
    if (!connected) return;
    connected = false;
    input.off("data", onData);
    input.destroy();
    output.end();
    events.emit("disconnect");
  };
  const onData = (chunk: Buffer | string) => {
    let messages: unknown[];
    try {
      messages = decoder.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    } catch {
      disconnect();
      return;
    }
    for (const message of messages) {
      if (!connected) return;
      events.emit("message", message);
    }
  };
  input.on("data", onData);
  input.once("end", disconnect);
  input.once("close", disconnect);
  input.once("error", disconnect);
  output.once("error", disconnect);
  output.once("close", disconnect);
  return {
    get connected() {
      return connected;
    },
    send: (message, callback) => {
      if (!connected) {
        callback(new Error("The desktop channel is closed."));
        return false;
      }
      let frame: Uint8Array;
      try {
        frame = encodeBackendFrame(message);
      } catch (error) {
        callback(error instanceof Error ? error : new Error(String(error)));
        return false;
      }
      // `write` queues without limit while the desktop isn't reading; bound it here.
      if (output.writableLength + frame.byteLength > maxPendingBytes) {
        disconnect();
        callback(new Error("The desktop stopped reading the channel."));
        return false;
      }
      return output.write(frame, (error) => callback(error ?? null));
    },
    on: (event, listener) => events.on(event, listener),
    off: (event, listener) => events.off(event, listener),
  };
}

/**
 * Frames on fds 3 (in) and 4 (out), as `f5-guest launch` arranges them, through the
 * private close-on-exec copies the server entry claimed (see guestFrameFds.ts).
 */
export function guestFrameIpc(): ComputerIpcProcess {
  const { input, output } = claimGuestFrameFds();
  return frameStreamIpc(
    new Net.Socket({ fd: input, readable: true, writable: false }),
    new Net.Socket({ fd: output, readable: false, writable: true }),
  );
}
