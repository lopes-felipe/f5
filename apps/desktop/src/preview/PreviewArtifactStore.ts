import { randomUUID } from "node:crypto";
import {
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
import path from "node:path";

import type { PreviewArtifact } from "@t3tools/contracts";

const DEFAULT_QUOTA_BYTES = 1024 * 1024 * 1024;
const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_RETENTION_MS = 7 * DAY_MS;
/** Remembers the configured retention so startup expiry does not fall back to the default. */
const RETENTION_FILE = ".retention.json";

function isValidRetentionDays(days: unknown): days is number {
  return typeof days === "number" && Number.isInteger(days) && days >= 1 && days <= 3650;
}
const SCREENSHOT_MAX_BYTES = 25 * 1024 * 1024;
const RECORDING_MAX_BYTES = 250 * 1024 * 1024;
const RECORDING_MAX_DURATION_MS = 5 * 60 * 1000;
const RECORDING_MAX_CHUNK_BYTES = 4 * 1024 * 1024;
const RECORDING_MAX_PENDING_BYTES = 8 * 1024 * 1024;
const RECORDING_MAX_PENDING_CHUNKS = 2;

interface RecordingEntry {
  readonly recordingId: string;
  readonly artifactId: string;
  readonly tabId: string;
  readonly createdAt: string;
  readonly startedAtMs: number;
  readonly width: number;
  readonly height: number;
  readonly temporaryPath: string;
  readonly finalPath: string;
  readonly handle: FileHandle;
  bytes: number;
  pendingBytes: number;
  pendingChunks: number;
  writeTail: Promise<void>;
  closed: boolean;
}

export interface PreviewArtifactStoreOptions {
  readonly directory: string;
  readonly quotaBytes?: number;
  readonly retentionMs?: number;
  readonly now?: () => number;
}

export interface BeginPreviewRecordingInput {
  readonly tabId: string;
  readonly width: number;
  readonly height: number;
}

export interface PreviewRecordingHandle {
  readonly recordingId: string;
  readonly tabId: string;
  readonly startedAt: string;
}

interface StoredFile {
  readonly path: string;
  readonly bytes: number;
  readonly modifiedAtMs: number;
}

export class PreviewArtifactStore {
  readonly #directory: string;
  readonly #quotaBytes: number;
  #retentionMs: number;
  readonly #retentionFromOptions: boolean;
  /** Retention days requested by each profile; null means the default. */
  readonly #retentionByScope = new Map<string, number | null>();
  readonly #now: () => number;
  readonly #recordings = new Map<string, RecordingEntry>();
  #quotaOperationTail: Promise<void> = Promise.resolve();

  constructor(options: PreviewArtifactStoreOptions) {
    this.#directory = path.resolve(options.directory);
    this.#quotaBytes = options.quotaBytes ?? DEFAULT_QUOTA_BYTES;
    this.#retentionMs = options.retentionMs ?? DEFAULT_RETENTION_MS;
    this.#retentionFromOptions = options.retentionMs !== undefined;
    this.#now = options.now ?? Date.now;
  }

  /**
   * Screenshot and recording retention from one profile's storage settings.
   * Null means that profile uses the built-in default. Artifacts are shared
   * by every profile, so the longest retention any profile asked for applies:
   * one profile's setting never expires artifacts another still keeps.
   * Expired artifacts are removed right away.
   */
  async setRetention(scope: string, days: number | null): Promise<void> {
    if (days !== null && !isValidRetentionDays(days)) {
      throw new Error("Preview artifact retention must be between 1 and 3650 days.");
    }
    // Serialized with every expiry pass, so a pass that computed its cutoff
    // under an older, shorter policy cannot run after a longer one applies.
    await this.#withQuotaLock(async () => {
      this.#retentionByScope.set(scope, days);
      this.#applyRetention();
      await this.#persistRetention();
      await this.#removeExpiredArtifactsUnlocked();
    });
  }

  /** Same-directory temp file and rename: a crash never leaves a torn policy file. */
  async #persistRetention(): Promise<void> {
    await mkdir(this.#directory, { recursive: true });
    const target = path.join(this.#directory, RETENTION_FILE);
    const temporary = `${target}.${randomUUID()}.tmp`;
    try {
      await writeFile(
        temporary,
        JSON.stringify({ byScope: Object.fromEntries(this.#retentionByScope) }),
      );
      await rename(temporary, target);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
  }

  #applyRetention(): void {
    if (this.#retentionByScope.size === 0) {
      this.#retentionMs = DEFAULT_RETENTION_MS;
      return;
    }
    let longest = 0;
    for (const days of this.#retentionByScope.values()) {
      longest = Math.max(longest, days === null ? DEFAULT_RETENTION_MS : days * DAY_MS);
    }
    this.#retentionMs = longest;
  }

  async #loadSavedRetention(): Promise<void> {
    const raw = await readFile(path.join(this.#directory, RETENTION_FILE), "utf8").catch(
      () => null,
    );
    if (raw === null) return;
    let byScope: unknown = null;
    try {
      byScope = (JSON.parse(raw) as { byScope?: unknown }).byScope;
    } catch {
      return;
    }
    if (typeof byScope !== "object" || byScope === null) return;
    for (const [scope, days] of Object.entries(byScope)) {
      if (days === null || isValidRetentionDays(days)) this.#retentionByScope.set(scope, days);
    }
    this.#applyRetention();
  }

  async initialize(): Promise<void> {
    await mkdir(this.#directory, { recursive: true });
    const entries = await readdir(this.#directory, { withFileTypes: true });
    await Promise.all(
      entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".tmp"))
        .map((entry) => rm(path.join(this.#directory, entry.name), { force: true })),
    );
    if (this.#retentionFromOptions === false) await this.#loadSavedRetention();
    await this.#removeExpiredArtifacts();
    await this.#enforceQuota(0);
  }

  async captureScreenshot(input: {
    readonly png: Uint8Array;
    readonly width: number;
    readonly height: number;
  }): Promise<PreviewArtifact> {
    if (input.png.byteLength > SCREENSHOT_MAX_BYTES) {
      throw new Error(`Preview screenshot exceeds the ${SCREENSHOT_MAX_BYTES} byte limit.`);
    }
    const artifactId = `preview-${randomUUID()}`;
    const createdAt = new Date(this.#now()).toISOString();
    await this.#writeAtomic(artifactId, "png", input.png);
    return {
      artifactId,
      kind: "screenshot",
      mimeType: "image/png",
      bytes: input.png.byteLength,
      createdAt,
      width: input.width,
      height: input.height,
    };
  }

  async beginRecording(input: BeginPreviewRecordingInput): Promise<PreviewRecordingHandle> {
    const recordingId = `recording-${randomUUID()}`;
    const artifactId = `preview-${randomUUID()}`;
    const startedAtMs = this.#now();
    const createdAt = new Date(startedAtMs).toISOString();
    const temporaryPath = path.join(this.#directory, `${artifactId}.webm.tmp`);
    const finalPath = path.join(this.#directory, `${artifactId}.webm`);
    await mkdir(this.#directory, { recursive: true });
    const handle = await open(temporaryPath, "wx", 0o600);
    this.#recordings.set(recordingId, {
      recordingId,
      artifactId,
      tabId: input.tabId,
      createdAt,
      startedAtMs,
      width: input.width,
      height: input.height,
      temporaryPath,
      finalPath,
      handle,
      bytes: 0,
      pendingBytes: 0,
      pendingChunks: 0,
      writeTail: Promise.resolve(),
      closed: false,
    });
    return { recordingId, tabId: input.tabId, startedAt: createdAt };
  }

  async appendRecordingChunk(recordingId: string, chunk: Uint8Array): Promise<void> {
    const recording = this.#requireRecording(recordingId);
    if (chunk.byteLength > RECORDING_MAX_CHUNK_BYTES) {
      throw new Error(`Preview recording chunk exceeds ${RECORDING_MAX_CHUNK_BYTES} bytes.`);
    }
    await this.#withQuotaLock(async () => {
      this.#requireRecording(recordingId);
      if (
        recording.pendingChunks >= RECORDING_MAX_PENDING_CHUNKS ||
        recording.pendingBytes + chunk.byteLength > RECORDING_MAX_PENDING_BYTES
      ) {
        throw new Error("Preview recording backpressure limit exceeded.");
      }
      if (this.#now() - recording.startedAtMs > RECORDING_MAX_DURATION_MS) {
        throw new Error("Preview recording exceeded the five minute limit.");
      }
      if (recording.bytes + recording.pendingBytes + chunk.byteLength > RECORDING_MAX_BYTES) {
        throw new Error(`Preview recording exceeds the ${RECORDING_MAX_BYTES} byte limit.`);
      }
      await this.#enforceQuotaUnlocked(chunk.byteLength);

      recording.pendingChunks += 1;
      recording.pendingBytes += chunk.byteLength;
      const previousWrite = recording.writeTail;
      const queuedWrite = async () => {
        try {
          await previousWrite;
          await recording.handle.write(chunk);
          recording.bytes += chunk.byteLength;
        } finally {
          recording.pendingChunks -= 1;
          recording.pendingBytes -= chunk.byteLength;
        }
      };
      recording.writeTail = queuedWrite();
      await recording.writeTail;
    });
  }

  async commitRecording(recordingId: string): Promise<PreviewArtifact> {
    return this.#withQuotaLock(async () => {
      const recording = this.#requireRecording(recordingId);
      if (recording.pendingChunks !== 0) {
        throw new Error("Preview recording still has chunks in flight.");
      }
      recording.closed = true;
      this.#recordings.delete(recordingId);
      try {
        await this.#enforceQuotaUnlocked(recording.bytes);
        await recording.handle.sync();
        await recording.handle.close();
        await rename(recording.temporaryPath, recording.finalPath);
        await this.#syncDirectory();
      } catch (cause) {
        await recording.handle.close().catch(() => undefined);
        await rm(recording.temporaryPath, { force: true }).catch(() => undefined);
        throw cause;
      }
      return {
        artifactId: recording.artifactId,
        kind: "recording",
        mimeType: "video/webm",
        bytes: recording.bytes,
        createdAt: recording.createdAt,
        width: recording.width,
        height: recording.height,
        durationMs: Math.max(0, this.#now() - recording.startedAtMs),
      };
    });
  }

  async discardRecording(recordingId: string): Promise<void> {
    const recording = this.#recordings.get(recordingId);
    if (!recording) return;
    this.#recordings.delete(recordingId);
    recording.closed = true;
    await recording.handle.close().catch(() => undefined);
    await rm(recording.temporaryPath, { force: true }).catch(() => undefined);
  }

  async dispose(): Promise<void> {
    await Promise.all([...this.#recordings.keys()].map((id) => this.discardRecording(id)));
  }

  #requireRecording(recordingId: string): RecordingEntry {
    const recording = this.#recordings.get(recordingId);
    if (!recording || recording.closed) throw new Error("Unknown preview recording.");
    return recording;
  }

  async #writeAtomic(artifactId: string, extension: string, data: Uint8Array): Promise<void> {
    await this.#withQuotaLock(async () => {
      await mkdir(this.#directory, { recursive: true });
      await this.#enforceQuotaUnlocked(data.byteLength);
      const temporaryPath = path.join(this.#directory, `${artifactId}.${extension}.tmp`);
      const finalPath = path.join(this.#directory, `${artifactId}.${extension}`);
      const handle = await open(temporaryPath, "wx", 0o600);
      try {
        await handle.write(data);
        await handle.sync();
        await handle.close();
        await rename(temporaryPath, finalPath);
        await this.#syncDirectory();
      } catch (cause) {
        await handle.close().catch(() => undefined);
        await rm(temporaryPath, { force: true }).catch(() => undefined);
        throw cause;
      }
    });
  }

  async #storedFiles(): Promise<StoredFile[]> {
    const entries = await readdir(this.#directory, { withFileTypes: true }).catch(() => []);
    const files = await Promise.all(
      entries
        .filter(
          (entry) => entry.isFile() && !entry.name.endsWith(".tmp") && !entry.name.startsWith("."),
        )
        .map(async (entry): Promise<StoredFile | null> => {
          const filePath = path.join(this.#directory, entry.name);
          const details = await stat(filePath).catch(() => null);
          return details
            ? { path: filePath, bytes: details.size, modifiedAtMs: details.mtimeMs }
            : null;
        }),
    );
    return files.filter((entry): entry is StoredFile => entry !== null);
  }

  async #removeExpiredArtifacts(): Promise<void> {
    await this.#withQuotaLock(() => this.#removeExpiredArtifactsUnlocked());
  }

  /** Callers hold the quota lock; the cutoff is read under it. */
  async #removeExpiredArtifactsUnlocked(): Promise<void> {
    const cutoff = this.#now() - this.#retentionMs;
    const files = await this.#storedFiles();
    await Promise.all(
      files
        .filter((file) => file.modifiedAtMs < cutoff)
        .map((file) => rm(file.path, { force: true })),
    );
  }

  async #enforceQuota(incomingBytes: number): Promise<void> {
    await this.#withQuotaLock(() => this.#enforceQuotaUnlocked(incomingBytes));
  }

  async #enforceQuotaUnlocked(incomingBytes: number): Promise<void> {
    const activeRecordingBytes = [...this.#recordings.values()].reduce(
      (total, recording) => total + recording.bytes + recording.pendingBytes,
      0,
    );
    if (activeRecordingBytes + incomingBytes > this.#quotaBytes) {
      throw new Error("Preview artifact exceeds the shared artifact quota.");
    }
    const files = (await this.#storedFiles()).toSorted(
      (left, right) => left.modifiedAtMs - right.modifiedAtMs,
    );
    let totalBytes = activeRecordingBytes + files.reduce((total, file) => total + file.bytes, 0);
    for (const file of files) {
      if (totalBytes + incomingBytes <= this.#quotaBytes) break;
      await rm(file.path, { force: true });
      totalBytes -= file.bytes;
    }
    if (totalBytes + incomingBytes > this.#quotaBytes) {
      throw new Error("Preview artifact quota could not be reclaimed.");
    }
  }

  async #withQuotaLock<A>(operation: () => Promise<A>): Promise<A> {
    const previous = this.#quotaOperationTail;
    let release!: () => void;
    this.#quotaOperationTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  async #syncDirectory(): Promise<void> {
    const directoryHandle = await open(this.#directory, "r").catch(() => null);
    if (!directoryHandle) return;
    await directoryHandle.sync().catch(() => undefined);
    await directoryHandle.close().catch(() => undefined);
  }
}
