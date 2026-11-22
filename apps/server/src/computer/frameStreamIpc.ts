import { EventEmitter } from "node:events";
import * as Net from "node:net";
import type { Readable, Writable } from "node:stream";
import { BackendFrameDecoder, encodeBackendFrame } from "@t3tools/shared/backendFrames";
import type { ComputerIpcProcess } from "./DesktopComputerHost";

/**
 * A guest backend's end of its desktop channel: length-prefixed JSON frames over two byte
 * streams, presented with the same shape as inherited Node IPC. The guest launcher puts
 * main's frames on fd 3 and takes the backend's from fd 4, and points stdout at stderr, so
 * nothing the backend or its children print can corrupt the stream.
 *
 * Malformed input, end of stream or a write failure disconnects; nothing resynchronizes.
 */
export function frameStreamIpc(input: Readable, output: Writable): ComputerIpcProcess {
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
      return output.write(frame, (error) => callback(error ?? null));
    },
    on: (event, listener) => events.on(event, listener),
    off: (event, listener) => events.off(event, listener),
  };
}

/** Frames on fds 3 (in) and 4 (out), as `f5-guest launch` arranges them. */
export function guestFrameIpc(): ComputerIpcProcess {
  return frameStreamIpc(
    new Net.Socket({ fd: 3, readable: true, writable: false }),
    new Net.Socket({ fd: 4, readable: false, writable: true }),
  );
}
