import fs from "node:fs/promises";
import path from "node:path";
import { createLogger } from "../logger.ts";
const logger = createLogger("provider-log");
let failures = 0;

interface RecordEntry {
  readonly text: string;
  readonly bytes: number;
  readonly done: ReturnType<typeof Promise.withResolvers<void>>;
}
interface Writer {
  readonly path: string;
  readonly owners: Set<symbol>;
  readonly records: RecordEntry[];
  readonly waiters: Set<() => void>;
  maxBytes: number;
  maxFiles: number;
  bytes: number;
  active: Promise<void> | undefined;
  timer: ReturnType<typeof setTimeout> | undefined;
  lastUsed: number;
  size?: number | undefined;
}
const writers = new Map<string, Writer>();
const MAX_ENTRIES = 1_024;
const MAX_BYTES = 4 * 1024 * 1024;
const IDLE_MS = 60_000;
let idleTimer: ReturnType<typeof setInterval> | undefined;

export function providerLogWriterInventory() {
  return {
    failures,
    writers: writers.size,
    entries: [...writers.values()].reduce((n, writer) => n + writer.records.length, 0),
    bytes: [...writers.values()].reduce((n, writer) => n + writer.bytes, 0),
  };
}
function evictIdle() {
  for (const [key, writer] of writers)
    if (
      !writer.active &&
      !writer.timer &&
      !writer.records.length &&
      Date.now() - writer.lastUsed >= IDLE_MS
    )
      writers.delete(key);
  if (!writers.size && idleTimer) {
    clearInterval(idleTimer);
    idleTimer = undefined;
  }
}
async function renameIfPresent(source: string, target: string) {
  try {
    await fs.rename(source, target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}
async function rotate(writer: Writer) {
  await fs.rm(`${writer.path}.${writer.maxFiles}`, { force: true });
  for (let i = writer.maxFiles - 1; i >= 1; i--)
    await renameIfPresent(`${writer.path}.${i}`, `${writer.path}.${i + 1}`);
  await renameIfPresent(writer.path, `${writer.path}.1`);
}
async function append(writer: Writer, text: string) {
  await fs.mkdir(path.dirname(writer.path), { recursive: true });
  const needsTailCheck = writer.size === undefined;
  let size =
    writer.size ??
    (await fs.stat(writer.path).then(
      (stat) => stat.size,
      (error) => {
        if (error.code === "ENOENT") return 0;
        throw error;
      },
    ));
  if (size > 0 && size + Buffer.byteLength(text) > writer.maxBytes) {
    await rotate(writer);
    size = 0;
  }
  // Windows append-only handles cannot truncate a crashed/partial record.
  // This registry owns writes to the path; use explicit end positions instead.
  // String flags also work in Bun on Windows, whose numeric O_CREAT handling
  // can otherwise leave a missing log uncreated. Never truncate an existing log.
  const handle = await fs.open(writer.path, "r+").catch(async (error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
    return fs.open(writer.path, "wx+").catch((creationError: NodeJS.ErrnoException) => {
      if (creationError.code !== "EEXIST") throw creationError;
      return fs.open(writer.path, "r+");
    });
  });
  try {
    // A previous process can leave an incomplete line. It cannot prove that a
    // lifecycle/completion record committed; remove it before appending again.
    if (needsTailCheck && size > 0) {
      const lastByte = Buffer.alloc(1);
      await handle.read(lastByte, 0, 1, size - 1);
      if (lastByte[0] !== 10) {
        const block = Buffer.alloc(Math.min(size, 64 * 1024));
        let end = size;
        while (end > 0) {
          const start = Math.max(0, end - block.length);
          const read = await handle.read(block, 0, end - start, start);
          const newline = block.subarray(0, read.bytesRead).lastIndexOf(10);
          if (newline >= 0) {
            size = start + newline + 1;
            break;
          }
          end = start;
          if (end === 0) size = 0;
        }
        await handle.truncate(size);
      }
    }
    try {
      const buffer = Buffer.from(text, "utf8");
      let written = 0;
      while (written < buffer.length) {
        const result = await handle.write(buffer, written, buffer.length - written, size + written);
        if (result.bytesWritten === 0) throw new Error("Provider log append made no progress");
        written += result.bytesWritten;
      }
      writer.size = size + buffer.length;
    } catch (error) {
      // This registry exclusively owns appends to this path. Roll back a
      // partial append before retrying, so repair never sees a false envelope.
      await handle.truncate(size);
      writer.size = size;
      throw error;
    }
  } finally {
    await handle.close();
  }
}
function flush(writer: Writer): Promise<void> {
  if (writer.timer) {
    clearTimeout(writer.timer);
    writer.timer = undefined;
  }
  if (writer.active)
    return writer.active.then(() => (writer.records.length ? flush(writer) : undefined));
  if (!writer.records.length) return Promise.resolve();
  const work = async () => {
    while (writer.records.length) {
      // Keep rotation at record boundaries; batches never split a JSON line.
      const batch: RecordEntry[] = [];
      let bytes = 0;
      for (const record of writer.records) {
        if (
          batch.length &&
          (bytes + record.bytes > Math.min(writer.maxBytes, 256 * 1024) || batch.length >= 64)
        )
          break;
        batch.push(record);
        bytes += record.bytes;
      }
      let failure: unknown;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          await append(writer, batch.map((record) => record.text).join(""));
          failure = undefined;
          break;
        } catch (error) {
          failure = error;
          if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 50 * 2 ** attempt));
        }
      }
      if (failure) {
        failures += batch.length;
        logger.warn("provider log append incomplete after bounded retries", {
          filePath: writer.path,
          records: batch.length,
          error: String(failure),
        });
      }
      writer.records.splice(0, batch.length);
      writer.bytes -= bytes;
      writer.lastUsed = Date.now();
      for (const record of batch) {
        if (failure) record.done.reject(failure);
        else record.done.resolve();
      }
      for (const notify of writer.waiters) notify();
      writer.waiters.clear();
    }
  };
  writer.active = work().finally(() => {
    writer.active = undefined;
  });
  return writer.active;
}
export async function appendProviderLog(input: {
  filePath: string;
  owner: symbol;
  text: string;
  maxBytes: number;
  maxFiles: number;
  batchWindowMs: number;
  critical: boolean;
}) {
  evictIdle();
  // The factory resolves the parent identity once; both streams use it.
  const key = path.resolve(input.filePath);
  let writer = writers.get(key);
  if (!writer) {
    writer = {
      path: key,
      owners: new Set(),
      records: [],
      waiters: new Set(),
      maxBytes: input.maxBytes,
      maxFiles: input.maxFiles,
      bytes: 0,
      active: undefined,
      timer: undefined,
      lastUsed: Date.now(),
    };
    writers.set(key, writer);
    idleTimer ??= setInterval(evictIdle, 1_000);
    idleTimer.unref?.();
  }
  writer.owners.add(input.owner);
  writer.maxBytes = Math.min(writer.maxBytes, input.maxBytes);
  writer.maxFiles = Math.min(writer.maxFiles, input.maxFiles);
  const bytes = Buffer.byteLength(input.text);
  while (
    writer.records.length >= MAX_ENTRIES ||
    (writer.records.length > 0 && writer.bytes + bytes > MAX_BYTES)
  ) {
    // Accepted repair evidence is lossless. A large record may run alone.
    void flush(writer);
    await new Promise<void>((resolve) => writer!.waiters.add(resolve));
  }
  const done = Promise.withResolvers<void>();
  // Noncritical callers acknowledge admission; failures are still observed.
  void done.promise.catch(() => undefined);
  writer.records.push({ text: input.text, bytes, done });
  writer.bytes += bytes;
  writer.lastUsed = Date.now();
  if (input.critical) {
    void flush(writer);
    await done.promise;
  } else if (!writer.timer) {
    writer.timer = setTimeout(() => {
      writer!.timer = undefined;
      void flush(writer!);
    }, input.batchWindowMs);
    writer.timer.unref?.();
  }
}
export async function closeProviderLogs(owner: symbol) {
  const owned = [...writers.values()].filter((writer) => writer.owners.has(owner));
  await Promise.all(
    owned.map(async (writer) => {
      await flush(writer);
      writer.owners.delete(owner);
      if (!writer.owners.size && !writer.records.length && !writer.active)
        writers.delete(writer.path);
    }),
  );
  evictIdle();
}
