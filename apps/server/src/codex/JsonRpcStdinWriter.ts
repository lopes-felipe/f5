import type { Writable } from "node:stream";

export class JsonRpcDeliveryError extends Error {
  constructor(
    message: string,
    readonly deliveryCertainty: "not_sent" | "unknown",
    readonly deliveryRetryable = deliveryCertainty === "not_sent",
    cause?: unknown,
    readonly reason?: "too_large",
  ) {
    super(message, { cause });
  }
}

export interface JsonRpcWriteOptions {
  readonly signal?: AbortSignal;
  /** Absolute Date.now() deadline; includes queue admission and backpressure. */
  readonly deadline?: number;
  readonly lane?: "ordinary" | "control";
  /** Called immediately before invoking stdin.write, even if it throws. */
  readonly onWrite?: () => void;
}
export interface JsonRpcStdinWriter {
  readonly write: (message: unknown, options?: JsonRpcWriteOptions) => Promise<void>;
  readonly close: (cause?: unknown) => void;
}
interface Entry {
  readonly chunk: string;
  readonly bytes: number;
  readonly lane: "ordinary" | "control";
  readonly options: JsonRpcWriteOptions;
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout> | undefined;
  abort: (() => void) | undefined;
  settled: boolean;
  written: boolean;
  readonly order: number;
  readonly turnThreadId: string | undefined;
  readonly interrupt: boolean;
}

/** A bounded FIFO per lane. Control can overtake queued bulk, never an active write. */
export function createJsonRpcStdinWriter(input: {
  readonly stdin: Writable;
  readonly closedMessage: string;
  readonly maxEntries?: number;
  readonly maxBytes?: number;
  readonly controlEntries?: number;
  readonly controlBytes?: number;
}): JsonRpcStdinWriter {
  const ordinary: Entry[] = [],
    control: Entry[] = [];
  const sizes = { ordinary: { entries: 0, bytes: 0 }, control: { entries: 0, bytes: 0 } };
  let active: Entry | null = null;
  let closed: unknown = null;
  let pumpScheduled = false;
  let detachActive: (() => void) | null = null;
  let nextOrder = 0;
  const deliveryError = (cause: unknown, written: boolean, retryable = !written) =>
    new JsonRpcDeliveryError(
      cause instanceof Error
        ? cause.message
        : typeof cause === "string"
          ? cause
          : input.closedMessage,
      written ? "unknown" : "not_sent",
      retryable,
      cause,
    );
  const settle = (entry: Entry, error?: Error) => {
    if (entry.settled) return;
    entry.settled = true;
    if (entry.timer) clearTimeout(entry.timer);
    if (entry.abort) entry.options.signal?.removeEventListener("abort", entry.abort);
    entry.timer = entry.abort = undefined;
    if (error) entry.reject(error);
    else entry.resolve();
  };
  const release = (entry: Entry) => {
    sizes[entry.lane].entries--;
    sizes[entry.lane].bytes -= entry.bytes;
  };
  const close = (cause: unknown = new Error(input.closedMessage)) => {
    if (closed !== null) return;
    closed = cause;
    input.stdin.off("error", onError);
    input.stdin.off("close", onClose);
    detachActive?.();
    detachActive = null;
    if (active) {
      settle(active, deliveryError(cause, active.written));
      release(active);
      active = null;
    }
    for (const entry of [...control.splice(0), ...ordinary.splice(0)]) {
      settle(entry, deliveryError(cause, false));
      release(entry);
    }
  };
  const onError = (cause: unknown) => close(cause);
  const onClose = () => close(new Error(input.closedMessage));
  input.stdin.on("error", onError);
  input.stdin.on("close", onClose);

  const schedulePump = () => {
    if (pumpScheduled || closed !== null) return;
    pumpScheduled = true;
    queueMicrotask(() => {
      pumpScheduled = false;
      pump();
    });
  };
  const cancel = (entry: Entry, message: string) => {
    settle(entry, deliveryError(new Error(message), entry.written));
    if (entry === active) return; // Still own the pipe until callback + drain.
    const queue = entry.lane === "control" ? control : ordinary;
    const index = queue.indexOf(entry);
    if (index >= 0) {
      queue.splice(index, 1);
      release(entry);
    }
    schedulePump();
  };
  const pump = () => {
    if (active || closed !== null) return;
    // An interrupt may bypass other threads' bulk work, but cannot arrive on
    // the wire before this thread's earlier queued start/steer frames.
    const nextControl = control[0];
    const predecessor =
      nextControl?.interrupt && nextControl.turnThreadId !== undefined
        ? ordinary.findIndex(
            (entry) =>
              entry.order < nextControl.order && entry.turnThreadId === nextControl.turnThreadId,
          )
        : -1;
    const entry =
      predecessor >= 0 ? ordinary.splice(predecessor, 1)[0] : (control.shift() ?? ordinary.shift());
    if (!entry) return;
    if (
      entry.options.signal?.aborted ||
      (entry.options.deadline !== undefined && Date.now() >= entry.options.deadline)
    ) {
      settle(entry, deliveryError(new Error("JSON-RPC write expired before send."), false));
      release(entry);
      schedulePump();
      return;
    }
    if (input.stdin.destroyed || !input.stdin.writable) {
      active = entry;
      close();
      return;
    }
    active = entry;
    let returned = false,
      callbackDone = false,
      drained = false,
      needsDrain = false;
    const onDrain = () => {
      drained = true;
      finish();
    };
    const finish = () => {
      if (active !== entry || !returned || !callbackDone || (needsDrain && !drained)) return;
      detachActive?.();
      detachActive = null;
      active = null;
      release(entry);
      settle(entry);
      schedulePump();
    };
    detachActive = () => input.stdin.off("drain", onDrain);
    input.stdin.on("drain", onDrain);
    try {
      entry.written = true;
      entry.options.onWrite?.();
      needsDrain = !input.stdin.write(entry.chunk, (error) => {
        if (error) {
          close(error);
          return;
        }
        callbackDone = true;
        finish();
      });
      returned = true;
      finish();
    } catch (cause) {
      close(cause);
    }
  };

  return {
    write(message, options = {}) {
      if (closed !== null) return Promise.reject(deliveryError(closed, false));
      if (
        options.signal?.aborted ||
        (options.deadline !== undefined && Date.now() >= options.deadline)
      )
        return Promise.reject(
          deliveryError(new Error("JSON-RPC write cancelled before admission."), false),
        );
      let chunk: string;
      try {
        chunk = `${JSON.stringify(message)}\n`;
      } catch (cause) {
        return Promise.reject(deliveryError(cause, false, false));
      }
      const bytes = Buffer.byteLength(chunk);
      const lane = options.lane ?? "ordinary";
      const limitEntries =
        lane === "control" ? (input.controlEntries ?? 64) : (input.maxEntries ?? 256);
      const limitBytes =
        lane === "control"
          ? (input.controlBytes ?? 1024 * 1024)
          : (input.maxBytes ?? 8 * 1024 * 1024);
      if (bytes > limitBytes)
        return Promise.reject(
          new JsonRpcDeliveryError(
            "JSON-RPC frame exceeds the lane byte limit; request was not sent.",
            "not_sent",
            false,
            undefined,
            "too_large",
          ),
        );
      if (sizes[lane].entries >= limitEntries || sizes[lane].bytes + bytes > limitBytes)
        return Promise.reject(
          deliveryError(new Error("JSON-RPC admission is full; request was not sent."), false),
        );
      return new Promise<void>((resolve, reject) => {
        const frame =
          message && typeof message === "object" ? (message as Record<string, unknown>) : undefined;
        const params =
          frame?.params && typeof frame.params === "object"
            ? (frame.params as Record<string, unknown>)
            : undefined;
        const entry: Entry = {
          chunk,
          bytes,
          lane,
          options,
          resolve,
          reject,
          timer: undefined,
          abort: undefined,
          settled: false,
          written: false,
          order: ++nextOrder,
          turnThreadId:
            (frame?.method === "turn/start" ||
              frame?.method === "turn/steer" ||
              frame?.method === "turn/interrupt") &&
            typeof params?.threadId === "string"
              ? params.threadId
              : undefined,
          interrupt: frame?.method === "turn/interrupt",
        };
        sizes[lane].entries++;
        sizes[lane].bytes += bytes;
        (lane === "control" ? control : ordinary).push(entry);
        if (options.signal) {
          entry.abort = () => cancel(entry, "JSON-RPC write aborted.");
          options.signal.addEventListener("abort", entry.abort, { once: true });
        }
        if (options.deadline !== undefined)
          entry.timer = setTimeout(
            () => cancel(entry, "JSON-RPC write deadline exceeded."),
            Math.max(0, options.deadline - Date.now()),
          );
        schedulePump();
      });
    },
    close,
  };
}

/** Interrupts and replies to provider prompts retain progress under bulk load. */
export function jsonRpcWriteLane(message: unknown): "ordinary" | "control" {
  if (message && typeof message === "object") {
    const frame = message as Record<string, unknown>;
    if (
      frame.method === "turn/interrupt" ||
      frame.method === "thread/sample/cancel" ||
      (frame.id !== undefined && frame.method === undefined)
    )
      return "control";
  }
  return "ordinary";
}
