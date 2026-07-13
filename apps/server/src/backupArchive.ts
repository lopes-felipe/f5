import { createCipheriv, createDecipheriv, createHash, randomBytes, scrypt } from "node:crypto";
import { createReadStream, createWriteStream, type WriteStream } from "node:fs";
import { mkdir, open, rm, stat, statfs } from "node:fs/promises";
import { posix as posixPath, resolve as resolvePath, sep as pathSeparator } from "node:path";
import { createGunzip, createGzip } from "node:zlib";
import { once } from "node:events";
import { finished, pipeline } from "node:stream/promises";
import { Transform, type Readable, type Writable } from "node:stream";

const MAGIC = Buffer.from("F5BACKUP1\n", "utf8");
const FILE_RECORD = 0x46;
const MANIFEST_RECORD = 0x4d;
const END_RECORD = 0x45;
const ENCRYPTED_FLAG = 1;
const MAX_MANIFEST_BYTES = 16 * 1024 * 1024;
const MAX_PATH_BYTES = 16 * 1024;
const GIBIBYTE = 1024 * 1024 * 1024;
const EXPANSION_RATIO_GRACE_BYTES = 16 * 1024 * 1024;
const MAX_FILE_COUNT = 100_000;

export interface BackupRestoreLimits {
  readonly maxCompressedBytes: number;
  readonly maxDecompressedBytes: number;
  readonly maxTemporaryBytes: number;
  readonly maxExpansionRatio: number;
  readonly minFreeBytes: number;
}

export const DEFAULT_BACKUP_RESTORE_LIMITS: BackupRestoreLimits = {
  maxCompressedBytes: 2 * GIBIBYTE,
  maxDecompressedBytes: 8 * GIBIBYTE,
  // Parsing temporarily retains the decompressed record stream alongside the
  // extracted payload. Keep their combined footprint bounded as well.
  maxTemporaryBytes: 16 * GIBIBYTE,
  maxExpansionRatio: 200,
  minFreeBytes: 512 * 1024 * 1024,
};

function positiveSafeIntegerFromEnv(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return value;
}

function nonNegativeSafeIntegerFromEnv(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer.`);
  }
  return value;
}

export function resolveBackupRestoreLimits(
  env: NodeJS.ProcessEnv = process.env,
): BackupRestoreLimits {
  return {
    maxCompressedBytes: positiveSafeIntegerFromEnv(
      env,
      "F5_BACKUP_MAX_COMPRESSED_BYTES",
      DEFAULT_BACKUP_RESTORE_LIMITS.maxCompressedBytes,
    ),
    maxDecompressedBytes: positiveSafeIntegerFromEnv(
      env,
      "F5_BACKUP_MAX_DECOMPRESSED_BYTES",
      DEFAULT_BACKUP_RESTORE_LIMITS.maxDecompressedBytes,
    ),
    maxTemporaryBytes: positiveSafeIntegerFromEnv(
      env,
      "F5_BACKUP_MAX_TEMPORARY_BYTES",
      DEFAULT_BACKUP_RESTORE_LIMITS.maxTemporaryBytes,
    ),
    maxExpansionRatio: positiveSafeIntegerFromEnv(
      env,
      "F5_BACKUP_MAX_EXPANSION_RATIO",
      DEFAULT_BACKUP_RESTORE_LIMITS.maxExpansionRatio,
    ),
    minFreeBytes: nonNegativeSafeIntegerFromEnv(
      env,
      "F5_BACKUP_MIN_FREE_BYTES",
      DEFAULT_BACKUP_RESTORE_LIMITS.minFreeBytes,
    ),
  };
}

export async function backupTemporaryStorageBudget(
  directory: string,
  limits: BackupRestoreLimits,
): Promise<number> {
  const volume = await statfs(directory);
  const availableBytes = Math.min(
    Number.MAX_SAFE_INTEGER,
    Number(volume.bavail) * Number(volume.bsize),
  );
  return Math.min(limits.maxTemporaryBytes, Math.max(0, availableBytes - limits.minFreeBytes));
}

export interface BackupArchiveEntry {
  readonly archivePath: string;
  readonly sourcePath: string;
  readonly encrypt: boolean;
}

export interface BackupManifestFile {
  readonly path: string;
  readonly size: number;
  readonly sha256: string;
  readonly encrypted: boolean;
}

export interface BackupManifest {
  readonly format: "f5-backup";
  readonly version: 1;
  readonly createdAt: string;
  readonly appVersion: string;
  readonly files: ReadonlyArray<BackupManifestFile>;
  readonly encryption?: {
    readonly algorithm: "aes-256-gcm";
    readonly kdf: "scrypt";
    readonly salt: string;
  };
}

export interface ParsedBackupArchive {
  readonly manifest: BackupManifest;
  readonly payloadDir: string;
}

interface ParsedRecord {
  readonly path: string;
  readonly size: number;
  readonly sha256: string;
  readonly encrypted: boolean;
  readonly storedPath: string;
}

function normalizeArchivePath(value: string): string {
  if (value.includes("\\") || value.includes("\0")) {
    throw new Error(`Invalid backup path '${value}'.`);
  }
  const normalized = posixPath.normalize(value);
  if (
    normalized.length === 0 ||
    normalized === "." ||
    normalized.startsWith("/") ||
    normalized === ".." ||
    normalized.startsWith("../")
  ) {
    throw new Error(`Invalid backup path '${value}'.`);
  }
  const allowed =
    normalized === "database.sqlite" ||
    normalized === "settings.json" ||
    normalized === "keybindings.json" ||
    normalized.startsWith("attachments/") ||
    normalized.startsWith("secrets/");
  if (!allowed) throw new Error(`Unsupported backup path '${value}'.`);
  return normalized;
}

function destinationPath(root: string, archivePath: string): string {
  const normalized = normalizeArchivePath(archivePath);
  const destination = resolvePath(root, ...normalized.split("/"));
  const rootPrefix = root.endsWith(pathSeparator) ? root : `${root}${pathSeparator}`;
  if (!destination.startsWith(rootPrefix)) throw new Error(`Unsafe backup path '${archivePath}'.`);
  return destination;
}

async function writeChunk(
  output: Writable,
  chunk: Uint8Array,
  outputUnavailable?: Promise<never>,
): Promise<void> {
  if (output.destroyed) {
    throw output.errored ?? new Error("Backup output closed unexpectedly.");
  }
  if (!output.write(chunk)) {
    await (outputUnavailable
      ? Promise.race([once(output, "drain"), outputUnavailable])
      : once(output, "drain"));
  }
}

function fileHeader(pathBytes: Buffer, size: number, encrypted: boolean): Buffer {
  const header = Buffer.allocUnsafe(14);
  header.writeUInt8(FILE_RECORD, 0);
  header.writeUInt32BE(pathBytes.length, 1);
  header.writeBigUInt64BE(BigInt(size), 5);
  header.writeUInt8(encrypted ? ENCRYPTED_FLAG : 0, 13);
  return header;
}

async function encryptionKey(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, 32, (error, key) => {
      if (error) reject(error);
      else resolve(Buffer.from(key));
    });
  });
}

async function writePlainFile(
  output: Writable,
  sourcePath: string,
  hash: ReturnType<typeof createHash>,
  outputUnavailable: Promise<never>,
): Promise<void> {
  for await (const chunk of createReadStream(sourcePath)) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    hash.update(bytes);
    await writeChunk(output, bytes, outputUnavailable);
  }
}

async function writeEncryptedFile(
  output: Writable,
  sourcePath: string,
  key: Buffer,
  hash: ReturnType<typeof createHash>,
  outputUnavailable: Promise<never>,
): Promise<void> {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  hash.update(iv);
  await writeChunk(output, iv, outputUnavailable);
  for await (const chunk of createReadStream(sourcePath)) {
    const encrypted = cipher.update(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    if (encrypted.length > 0) {
      hash.update(encrypted);
      await writeChunk(output, encrypted, outputUnavailable);
    }
  }
  const final = cipher.final();
  if (final.length > 0) {
    hash.update(final);
    await writeChunk(output, final, outputUnavailable);
  }
  const tag = cipher.getAuthTag();
  hash.update(tag);
  await writeChunk(output, tag, outputUnavailable);
}

export async function writeBackupArchive(input: {
  readonly output: Writable;
  readonly entries: ReadonlyArray<BackupArchiveEntry>;
  readonly appVersion: string;
  readonly password?: string;
  readonly maxArchiveBytes?: number;
}): Promise<BackupManifest> {
  const entries = [...input.entries].sort((left, right) =>
    left.archivePath.localeCompare(right.archivePath),
  );
  if (!entries.some((entry) => entry.archivePath === "database.sqlite")) {
    throw new Error("A backup must contain database.sqlite.");
  }
  const encryptedEntries = entries.filter((entry) => entry.encrypt);
  if (encryptedEntries.length > 0 && !input.password) {
    throw new Error("A password is required to export encrypted secrets.");
  }
  const salt = encryptedEntries.length > 0 ? randomBytes(16) : null;
  const key = salt && input.password ? await encryptionKey(input.password, salt) : null;
  const gzip = createGzip({ level: 6 });
  const outputFinished = input.maxArchiveBytes
    ? pipeline(
        gzip,
        new ByteLimitTransform(
          input.maxArchiveBytes,
          "Backup archive exceeds the configured export size limit.",
        ),
        input.output,
      )
    : pipeline(gzip, input.output);
  const outputUnavailable = outputFinished.then<never>(
    () => {
      throw new Error("Backup output closed before the archive producer completed.");
    },
    (error) => {
      throw error;
    },
  );
  // Attach a rejection handler immediately; the producer loop below will also
  // observe and rethrow the pipeline failure when it awaits this promise.
  void outputFinished.catch(() => {});
  void outputUnavailable.catch(() => {});

  try {
    await writeChunk(gzip, MAGIC, outputUnavailable);
    const files: BackupManifestFile[] = [];
    for (const entry of entries) {
      const archivePath = normalizeArchivePath(entry.archivePath);
      const info = await stat(entry.sourcePath);
      if (!info.isFile()) continue;
      const storedSize = info.size + (entry.encrypt ? 28 : 0);
      const pathBytes = Buffer.from(archivePath, "utf8");
      if (pathBytes.length > MAX_PATH_BYTES)
        throw new Error(`Backup path is too long: ${archivePath}`);
      await writeChunk(gzip, fileHeader(pathBytes, storedSize, entry.encrypt), outputUnavailable);
      await writeChunk(gzip, pathBytes, outputUnavailable);
      const hash = createHash("sha256");
      if (entry.encrypt) {
        await writeEncryptedFile(gzip, entry.sourcePath, key!, hash, outputUnavailable);
      } else {
        await writePlainFile(gzip, entry.sourcePath, hash, outputUnavailable);
      }
      files.push({
        path: archivePath,
        size: storedSize,
        sha256: hash.digest("hex"),
        encrypted: entry.encrypt,
      });
    }

    const manifest: BackupManifest = {
      format: "f5-backup",
      version: 1,
      createdAt: new Date().toISOString(),
      appVersion: input.appVersion,
      files,
      ...(salt
        ? {
            encryption: {
              algorithm: "aes-256-gcm",
              kdf: "scrypt",
              salt: salt.toString("base64"),
            },
          }
        : {}),
    };
    const manifestBytes = Buffer.from(JSON.stringify(manifest), "utf8");
    const manifestHeader = Buffer.allocUnsafe(5);
    manifestHeader.writeUInt8(MANIFEST_RECORD, 0);
    manifestHeader.writeUInt32BE(manifestBytes.length, 1);
    await writeChunk(gzip, manifestHeader, outputUnavailable);
    await writeChunk(gzip, manifestBytes, outputUnavailable);
    await writeChunk(gzip, createHash("sha256").update(manifestBytes).digest(), outputUnavailable);
    await writeChunk(gzip, Buffer.from([END_RECORD]), outputUnavailable);
    gzip.end();
    await outputFinished;
    return manifest;
  } catch (error) {
    gzip.destroy(error instanceof Error ? error : new Error(String(error)));
    await outputFinished.catch(() => {});
    throw error;
  } finally {
    key?.fill(0);
  }
}

class ByteLimitTransform extends Transform {
  #bytes = 0;

  constructor(
    private readonly limit: number,
    private readonly errorMessage: string,
  ) {
    super();
  }

  get bytes(): number {
    return this.#bytes;
  }

  override _transform(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null, data?: Buffer) => void,
  ): void {
    this.#bytes += chunk.length;
    if (this.#bytes > this.limit) {
      callback(new Error(this.errorMessage));
      return;
    }
    callback(null, chunk);
  }
}

class DecompressedLimitTransform extends Transform {
  #bytes = 0;

  constructor(
    private readonly compressed: ByteLimitTransform,
    private readonly limits: BackupRestoreLimits,
  ) {
    super();
  }

  override _transform(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null, data?: Buffer) => void,
  ): void {
    this.#bytes += chunk.length;
    if (this.#bytes > this.limits.maxDecompressedBytes) {
      callback(new Error("Backup archive exceeds the decompressed restore size limit."));
      return;
    }
    const ratioLimit = Math.max(
      EXPANSION_RATIO_GRACE_BYTES,
      this.compressed.bytes * this.limits.maxExpansionRatio,
    );
    if (this.#bytes > ratioLimit) {
      callback(new Error("Backup archive exceeds the allowed compression expansion ratio."));
      return;
    }
    callback(null, chunk);
  }
}

async function readExactly(
  handle: Awaited<ReturnType<typeof open>>,
  length: number,
  position: number,
): Promise<Buffer> {
  const buffer = Buffer.allocUnsafe(length);
  let offset = 0;
  while (offset < length) {
    const result = await handle.read(buffer, offset, length - offset, position + offset);
    if (result.bytesRead === 0) throw new Error("Backup archive ended unexpectedly.");
    offset += result.bytesRead;
  }
  return buffer;
}

async function copyRecordData(input: {
  readonly handle: Awaited<ReturnType<typeof open>>;
  readonly sourcePosition: number;
  readonly size: number;
  readonly destination: string;
}): Promise<string> {
  await mkdir(resolvePath(input.destination, ".."), { recursive: true });
  const output: WriteStream = createWriteStream(input.destination, { flags: "wx" });
  const hash = createHash("sha256");
  let remaining = input.size;
  let position = input.sourcePosition;
  try {
    while (remaining > 0) {
      const length = Math.min(1024 * 1024, remaining);
      const bytes = await readExactly(input.handle, length, position);
      hash.update(bytes);
      if (!output.write(bytes)) await once(output, "drain");
      remaining -= length;
      position += length;
    }
    output.end();
    await finished(output);
    return hash.digest("hex");
  } catch (error) {
    output.destroy();
    throw error;
  }
}

function decodeManifest(bytes: Buffer): BackupManifest {
  const parsed = JSON.parse(bytes.toString("utf8")) as Partial<BackupManifest>;
  if (
    parsed.format !== "f5-backup" ||
    parsed.version !== 1 ||
    typeof parsed.createdAt !== "string" ||
    typeof parsed.appVersion !== "string" ||
    !Array.isArray(parsed.files)
  ) {
    throw new Error("Unsupported or malformed F5 backup manifest.");
  }
  return parsed as BackupManifest;
}

async function decryptSecretFile(input: {
  readonly encryptedPath: string;
  readonly destination: string;
  readonly size: number;
  readonly key: Buffer;
}): Promise<void> {
  if (input.size < 28) throw new Error("Encrypted secret record is truncated.");
  const handle = await open(input.encryptedPath, "r");
  try {
    const iv = await readExactly(handle, 12, 0);
    const tag = await readExactly(handle, 16, input.size - 16);
    const decipher = createDecipheriv("aes-256-gcm", input.key, iv);
    decipher.setAuthTag(tag);
    await mkdir(resolvePath(input.destination, ".."), { recursive: true });
    await pipeline(
      createReadStream(input.encryptedPath, { start: 12, end: input.size - 17 }),
      decipher,
      createWriteStream(input.destination, { flags: "wx", mode: 0o600 }),
    );
  } catch (error) {
    await rm(input.destination, { force: true });
    throw new Error("Unable to decrypt backup secrets. Check the password and archive integrity.", {
      cause: error,
    });
  } finally {
    await handle.close();
  }
}

export async function parseBackupArchive(input: {
  readonly source: Readable;
  readonly stagingDir: string;
  readonly password?: string;
  readonly limits?: BackupRestoreLimits;
}): Promise<ParsedBackupArchive> {
  const limits = input.limits ?? resolveBackupRestoreLimits();
  const rawPath = resolvePath(input.stagingDir, "archive.raw");
  const payloadDir = resolvePath(input.stagingDir, "payload");
  await mkdir(payloadDir, { recursive: true });
  const maxTemporaryBytes = await backupTemporaryStorageBudget(input.stagingDir, limits);
  if (maxTemporaryBytes <= 0) {
    throw new Error("Not enough free disk space to stage a backup restore safely.");
  }
  const compressedLimit = new ByteLimitTransform(
    limits.maxCompressedBytes,
    "Backup upload exceeds the compressed restore size limit.",
  );
  await pipeline(
    input.source,
    compressedLimit,
    createGunzip(),
    new DecompressedLimitTransform(compressedLimit, limits),
    createWriteStream(rawPath, { flags: "wx", mode: 0o600 }),
  );

  const handle = await open(rawPath, "r");
  const rawSize = (await handle.stat()).size;
  if (rawSize > maxTemporaryBytes) {
    await handle.close();
    await rm(rawPath, { force: true });
    throw new Error("Backup archive exceeds the temporary restore storage limit.");
  }
  const records: ParsedRecord[] = [];
  let extractedBytes = 0;
  let manifest: BackupManifest | null = null;
  let position = 0;
  try {
    const magic = await readExactly(handle, MAGIC.length, position);
    position += MAGIC.length;
    if (!magic.equals(MAGIC)) throw new Error("This file is not an F5 backup archive.");

    while (true) {
      const type = (await readExactly(handle, 1, position)).readUInt8(0);
      position += 1;
      if (type === FILE_RECORD) {
        if (records.length >= MAX_FILE_COUNT) throw new Error("Backup contains too many files.");
        const metadata = await readExactly(handle, 13, position);
        position += 13;
        const pathLength = metadata.readUInt32BE(0);
        const sizeBigInt = metadata.readBigUInt64BE(4);
        const encrypted = (metadata.readUInt8(12) & ENCRYPTED_FLAG) !== 0;
        if (pathLength === 0 || pathLength > MAX_PATH_BYTES) {
          throw new Error("Backup contains an invalid path length.");
        }
        if (
          sizeBigInt > BigInt(Number.MAX_SAFE_INTEGER) ||
          sizeBigInt > BigInt(limits.maxDecompressedBytes)
        ) {
          throw new Error("Backup contains an oversized file.");
        }
        const size = Number(sizeBigInt);
        const archivePath = normalizeArchivePath(
          (await readExactly(handle, pathLength, position)).toString("utf8"),
        );
        position += pathLength;
        if (records.some((record) => record.path === archivePath)) {
          throw new Error(`Backup contains duplicate path '${archivePath}'.`);
        }
        if (encrypted && !archivePath.startsWith("secrets/")) {
          throw new Error("Only secret files may be encrypted in a backup.");
        }
        const storedPath = `${destinationPath(payloadDir, archivePath)}${encrypted ? ".encrypted" : ""}`;
        if (rawSize + extractedBytes + size > maxTemporaryBytes) {
          throw new Error("Backup archive exceeds the temporary restore storage limit.");
        }
        const sha256 = await copyRecordData({
          handle,
          sourcePosition: position,
          size,
          destination: storedPath,
        });
        records.push({ path: archivePath, size, sha256, encrypted, storedPath });
        extractedBytes += size;
        position += size;
        continue;
      }
      if (type === MANIFEST_RECORD) {
        const manifestLength = (await readExactly(handle, 4, position)).readUInt32BE(0);
        position += 4;
        if (manifestLength === 0 || manifestLength > MAX_MANIFEST_BYTES) {
          throw new Error("Backup manifest size is invalid.");
        }
        const manifestBytes = await readExactly(handle, manifestLength, position);
        position += manifestLength;
        const checksum = await readExactly(handle, 32, position);
        position += 32;
        const expected = createHash("sha256").update(manifestBytes).digest();
        if (!checksum.equals(expected)) throw new Error("Backup manifest checksum does not match.");
        manifest = decodeManifest(manifestBytes);
        const end = (await readExactly(handle, 1, position)).readUInt8(0);
        position += 1;
        if (end !== END_RECORD) throw new Error("Backup archive has an invalid ending.");
        const archiveInfo = await handle.stat();
        if (position !== archiveInfo.size)
          throw new Error("Backup archive contains trailing data.");
        break;
      }
      throw new Error("Backup archive contains an unknown record type.");
    }
  } finally {
    await handle.close();
    await rm(rawPath, { force: true });
  }

  if (!manifest) throw new Error("Backup manifest is missing.");
  if (manifest.files.length !== records.length) {
    throw new Error("Backup manifest file count does not match the archive.");
  }
  const manifestFiles = new Map(manifest.files.map((file) => [file.path, file] as const));
  for (const record of records) {
    const expected = manifestFiles.get(record.path);
    if (
      !expected ||
      expected.size !== record.size ||
      expected.sha256 !== record.sha256 ||
      expected.encrypted !== record.encrypted
    ) {
      throw new Error(`Backup checksum validation failed for '${record.path}'.`);
    }
  }
  if (!manifestFiles.has("database.sqlite")) {
    throw new Error("Backup database is missing.");
  }

  const encryptedRecords = records.filter((record) => record.encrypted);
  if (encryptedRecords.length > 0) {
    if (!manifest.encryption || !input.password) {
      throw new Error("This backup contains encrypted secrets and requires a password.");
    }
    const salt = Buffer.from(manifest.encryption.salt, "base64");
    const key = await encryptionKey(input.password, salt);
    try {
      for (const record of encryptedRecords) {
        const destination = destinationPath(payloadDir, record.path);
        const plaintextSize = record.size - 28;
        if (extractedBytes + plaintextSize > maxTemporaryBytes) {
          throw new Error("Backup archive exceeds the temporary restore storage limit.");
        }
        await decryptSecretFile({
          encryptedPath: record.storedPath,
          destination,
          size: record.size,
          key,
        });
        await rm(record.storedPath, { force: true });
        extractedBytes = extractedBytes - record.size + plaintextSize;
      }
    } finally {
      key.fill(0);
    }
  }

  return { manifest, payloadDir };
}
