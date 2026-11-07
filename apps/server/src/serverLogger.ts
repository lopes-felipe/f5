import { RotatingFileSink } from "@t3tools/shared/logging";
import { Effect, Logger, Schema } from "effect";
import * as Layer from "effect/Layer";

import { ServerConfig } from "./config";

export const SERVER_LOG_MAX_BYTES = 10 * 1024 * 1024;
export const SERVER_LOG_MAX_FILES = 10;
export const SERVER_LOG_BATCH_WINDOW_MS = 200;

class ServerLoggerInitializationError extends Schema.TaggedErrorClass<ServerLoggerInitializationError>()(
  "ServerLoggerInitializationError",
  {
    filePath: Schema.String,
    cause: Schema.Defect,
  },
) {
  override get message(): string {
    return `Failed to initialize rotating server log '${this.filePath}'.`;
  }
}

function writeBoundedLogBatch(
  sink: RotatingFileSink,
  lines: ReadonlyArray<string>,
  maxBytes: number,
): void {
  let chunks: Buffer[] = [];
  let chunkBytes = 0;
  const flush = () => {
    if (chunkBytes === 0) return;
    sink.write(Buffer.concat(chunks, chunkBytes));
    chunks = [];
    chunkBytes = 0;
  };

  for (const line of lines) {
    let encoded = Buffer.from(`${line}\n`);
    if (encoded.length > maxBytes) {
      flush();
      while (encoded.length > maxBytes) {
        sink.write(encoded.subarray(0, maxBytes));
        encoded = encoded.subarray(maxBytes);
      }
    } else if (chunkBytes + encoded.length > maxBytes) {
      flush();
    }
    if (encoded.length > 0) {
      chunks.push(encoded);
      chunkBytes += encoded.length;
    }
  }
  flush();
}

export function makeRotatingServerFileLogger(
  filePath: string,
  options: {
    readonly maxBytes?: number;
    readonly maxFiles?: number;
    readonly batchWindowMs?: number;
  } = {},
) {
  return Effect.gen(function* () {
    const maxBytes = options.maxBytes ?? SERVER_LOG_MAX_BYTES;
    const sink = yield* Effect.try({
      try: () =>
        new RotatingFileSink({
          filePath,
          maxBytes,
          maxFiles: options.maxFiles ?? SERVER_LOG_MAX_FILES,
          throwOnError: true,
        }),
      catch: (cause) => new ServerLoggerInitializationError({ filePath, cause }),
    });

    return yield* Logger.batched(Logger.formatSimple, {
      window: options.batchWindowMs ?? SERVER_LOG_BATCH_WINDOW_MS,
      flush: (lines) =>
        Effect.sync(() => {
          if (lines.length === 0) return;
          try {
            writeBoundedLogBatch(sink, lines, maxBytes);
          } catch (cause) {
            // Do not recurse through the logger that just failed. Surface the
            // failure through stderr while retaining console logging.
            console.error(`Failed to write rotating server log '${filePath}'.`, cause);
          }
        }),
    });
  });
}

export const ServerLoggerLive = Effect.gen(function* () {
  const config = yield* ServerConfig;

  const fileLogger = makeRotatingServerFileLogger(config.serverLogPath);

  return Logger.layer([Logger.defaultLogger, fileLogger], {
    mergeWithExisting: false,
  });
}).pipe(Layer.unwrap);
