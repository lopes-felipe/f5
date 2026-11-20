import type { ChildProcess, Serializable } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { BackendFrameDecoder, encodeBackendFrame } from "@t3tools/shared/backendFrames";

/**
 * Main's private link to one backend incarnation. Main creates every channel itself and
 * registers it with the profile and incarnation it launched, so a backend never asserts its
 * own identity and there is no listener another process could reach.
 */
export interface BackendChannel {
  readonly connected: boolean;
  /**
   * Host OS pid of the backend process, for features that identify host descendants
   * (Chrome supervision, Sky). Absent for guest backends: a guest pid names no host process.
   */
  readonly hostPid: number | undefined;
  send(message: unknown): void;
  onMessage(listener: (raw: unknown) => void): void;
  /** Called once, when the channel can no longer carry messages or its process exits. */
  onDisconnect(listener: () => void): void;
  disconnect(): void;
}

/** A host backend: inherited Node IPC on the child main spawned. */
export function childProcessBackendChannel(child: ChildProcess): BackendChannel {
  return {
    get connected() {
      return child.connected;
    },
    get hostPid() {
      return child.pid;
    },
    send: (message) => {
      child.send(message as Serializable, () => undefined);
    },
    onMessage: (listener) => {
      child.on("message", listener);
    },
    onDisconnect: (listener) => {
      let fired = false;
      const once = () => {
        if (fired) return;
        fired = true;
        listener();
      };
      child.once("disconnect", once);
      child.once("exit", once);
    },
    disconnect: () => {
      child.disconnect();
    },
  };
}

/**
 * A guest backend: length-prefixed JSON frames over the stdio of the process main spawned
 * to reach it (`limactl shell`). Malformed input, end of stream or a write failure closes
 * the channel; the guest launcher treats the resulting stdin EOF as an order to stop every
 * process the backend owns.
 */
export function streamBackendChannel(io: {
  readonly input: Readable;
  readonly output: Writable;
  readonly maxFrameBytes?: number;
}): BackendChannel {
  const decoder = new BackendFrameDecoder(io.maxFrameBytes);
  const messageListeners: Array<(raw: unknown) => void> = [];
  const disconnectListeners: Array<() => void> = [];
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    io.input.off("data", onData);
    io.input.destroy();
    io.output.end();
    for (const listener of disconnectListeners.splice(0)) listener();
  };
  const onData = (chunk: Buffer | string) => {
    if (closed) return;
    let messages: unknown[];
    try {
      messages = decoder.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    } catch {
      close();
      return;
    }
    for (const message of messages) {
      if (closed) return;
      for (const listener of messageListeners) listener(message);
    }
  };
  io.input.on("data", onData);
  io.input.once("end", close);
  io.input.once("close", close);
  io.input.once("error", close);
  io.output.once("close", close);
  io.output.once("error", close);
  return {
    get connected() {
      return !closed && io.output.writable;
    },
    hostPid: undefined,
    send: (message) => {
      if (closed) return;
      let frame: Uint8Array;
      try {
        frame = encodeBackendFrame(message);
      } catch {
        // Main's own message failed to encode; dropping it beats corrupting the stream.
        return;
      }
      io.output.write(frame);
    },
    onMessage: (listener) => {
      messageListeners.push(listener);
    },
    onDisconnect: (listener) => {
      if (closed) listener();
      else disconnectListeners.push(listener);
    },
    disconnect: close,
  };
}
