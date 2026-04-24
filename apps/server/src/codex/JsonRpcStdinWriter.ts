import type { Writable } from "node:stream";

function toError(cause: unknown, fallbackMessage: string): Error {
  if (cause instanceof Error) {
    return cause;
  }
  if (typeof cause === "string" && cause.trim().length > 0) {
    return new Error(cause);
  }
  return new Error(fallbackMessage);
}

export interface JsonRpcStdinWriter {
  readonly write: (message: unknown) => Promise<void>;
  readonly close: (cause?: unknown) => void;
}

export function createJsonRpcStdinWriter(input: {
  readonly stdin: Writable;
  readonly closedMessage: string;
}): JsonRpcStdinWriter {
  let closedError: Error | null = null;
  let writeChain = Promise.resolve();

  const close = (cause?: unknown) => {
    if (closedError) {
      return;
    }
    closedError = toError(cause, input.closedMessage);
  };

  const writeChunk = async (chunk: string) => {
    if (closedError) {
      throw closedError;
    }
    if (input.stdin.destroyed || !input.stdin.writable) {
      const error = new Error(input.closedMessage);
      close(error);
      throw error;
    }

    await new Promise<void>((resolve, reject) => {
      let callbackCompleted = false;
      let drainCompleted = false;
      let settled = false;
      let requiresDrain = false;

      const cleanup = () => {
        input.stdin.off("error", onError);
        input.stdin.off("close", onClose);
        input.stdin.off("drain", onDrain);
      };

      const finish = () => {
        if (settled || !callbackCompleted || !drainCompleted) {
          return;
        }
        settled = true;
        cleanup();
        resolve();
      };

      const fail = (cause: unknown) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        const error = toError(cause, input.closedMessage);
        close(error);
        reject(error);
      };

      const onError = (cause: unknown) => fail(cause);
      const onClose = () => fail(new Error(input.closedMessage));
      const onDrain = () => {
        drainCompleted = true;
        finish();
      };

      input.stdin.once("error", onError);
      input.stdin.once("close", onClose);

      requiresDrain = !input.stdin.write(chunk, (error) => {
        if (error) {
          fail(error);
          return;
        }
        callbackCompleted = true;
        if (!requiresDrain) {
          drainCompleted = true;
        }
        finish();
      });

      if (requiresDrain) {
        input.stdin.once("drain", onDrain);
      }
    });
  };

  return {
    write: (message) => {
      const chunk = `${JSON.stringify(message)}\n`;
      const pending = writeChain.then(() => writeChunk(chunk));
      writeChain = pending.catch(() => undefined);
      return pending;
    },
    close,
  };
}
