import * as Crypto from "node:crypto";
import * as FS from "node:fs";
import * as FSP from "node:fs/promises";
import * as Path from "node:path";
import { acquireFileLock, LockHeld, type AcquireLock } from "./fileLock";

/** A guest image pinned by an F5 release (`apps/desktop/vm-guest/image.lock.json`). */
export interface GuestImagePin {
  readonly url: string;
  readonly sha256: string;
  readonly size: number;
}

export class GuestImageError extends Error {
  override readonly name = "GuestImageError";
}

/**
 * Images are published only as GitHub release assets of this repository: exactly
 * `/releases/download/<tag>/<file>`, checked on the parsed URL. The pin must already be in
 * normal form, so dot segments, escapes, a query or a fragment can't point elsewhere.
 */
const RELEASE_ASSET_PATH =
  /^\/lopes-felipe\/f5\/releases\/download\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

function isReleaseAssetUrl(value: string): boolean {
  if (!URL.canParse(value)) return false;
  const url = new URL(value);
  return (
    url.href === value &&
    url.origin === "https://github.com" &&
    url.username === "" &&
    url.password === "" &&
    url.search === "" &&
    url.hash === "" &&
    RELEASE_ASSET_PATH.test(url.pathname) &&
    !url.pathname.split("/").some((segment) => segment === "." || segment === "..")
  );
}

/** Upper bound for a compressed guest image; a pin claiming more is refused. */
export const MAX_GUEST_IMAGE_BYTES = 4 * 1024 ** 3;

export function parseGuestImagePin(
  value: unknown,
  options: { readonly allowAnyHttpsUrl?: boolean } = {},
): GuestImagePin | null {
  if (typeof value !== "object" || value === null) return null;
  const image = (value as { image?: unknown }).image;
  if (image === null || image === undefined) return null;
  if (typeof image !== "object") throw new GuestImageError("The guest image pin is malformed.");
  const { url, sha256, size } = image as Record<string, unknown>;
  if (typeof url !== "string" || typeof sha256 !== "string" || typeof size !== "number")
    throw new GuestImageError("The guest image pin is malformed.");
  if (!/^[0-9a-f]{64}$/.test(sha256))
    throw new GuestImageError("The guest image pin has an invalid digest.");
  if (!Number.isSafeInteger(size) || size <= 0 || size > MAX_GUEST_IMAGE_BYTES)
    throw new GuestImageError("The guest image pin has an invalid size.");
  const allowed = options.allowAnyHttpsUrl
    ? URL.canParse(url) && new URL(url).protocol === "https:"
    : isReleaseAssetUrl(url);
  if (!allowed) throw new GuestImageError("The guest image pin has a disallowed URL.");
  return { url, sha256, size };
}

export interface GuestImageProgress {
  readonly receivedBytes: number;
  readonly totalBytes: number;
}

/**
 * What a pinned download is: the cached file's extension and the name used in messages.
 * The guest image and the linux-arm64 backend archive share the same download path.
 */
export interface PinnedDownloadKind {
  readonly extension: string;
  readonly label: string;
}

export const GUEST_IMAGE: PinnedDownloadKind = { extension: ".qcow2", label: "guest image" };
export const BACKEND_ARCHIVE: PinnedDownloadKind = {
  extension: ".tar.gz",
  label: "F5 backend archive",
};

export interface EnsureGuestImageOptions {
  readonly pin: GuestImagePin;
  readonly cacheDir: string;
  readonly fetch?: typeof fetch;
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: GuestImageProgress) => void;
  /** The cross-process lock; tests off macOS inject their own. */
  readonly lock?: AcquireLock;
}

export interface EnsurePinnedDownloadOptions extends EnsureGuestImageOptions {
  readonly kind: PinnedDownloadKind;
}

export const pinnedDownloadPath = (cacheDir: string, sha256: string, kind: PinnedDownloadKind) =>
  Path.join(cacheDir, `${sha256}${kind.extension}`);

export const guestImagePath = (cacheDir: string, sha256: string) =>
  pinnedDownloadPath(cacheDir, sha256, GUEST_IMAGE);

async function hashFile(path: string, hash: Crypto.Hash): Promise<number> {
  let bytes = 0;
  for await (const chunk of FS.createReadStream(path)) {
    hash.update(chunk as Buffer);
    bytes += (chunk as Buffer).byteLength;
  }
  return bytes;
}

/** A cached image is usable when it exists with the pinned size. Never changes the cache. */
function cachedImage(finalPath: string, pin: GuestImagePin): boolean {
  try {
    return FS.statSync(finalPath).size === pin.size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/** The local path of the pinned guest image, downloading it if needed. */
export const ensureGuestImage = (options: EnsureGuestImageOptions): Promise<string> =>
  ensurePinnedDownload({ ...options, kind: GUEST_IMAGE });

/**
 * The local path of a pinned file (guest image or backend archive), downloading it if needed.
 *
 * Every VM profile's supervisor shares the cache, so one process at a time owns a digest's
 * download, from resume through rename, under `<digest><extension>.lock`; the others wait
 * for it and then find the finished file. Outside the lock the cache is only read; a file of
 * the wrong size is removed under it. A partial download resumes with a Range request; the
 * bytes already on disk are hashed again first, so a resumed file is verified end to end.
 * Only a file whose size and SHA-256 match the pin is renamed into place. The rename is
 * atomic and the cache sits in F5's own state directory, so a cached file with the pinned
 * size is trusted by name.
 */
export async function ensurePinnedDownload(options: EnsurePinnedDownloadOptions): Promise<string> {
  const { pin, cacheDir } = options;
  const finalPath = pinnedDownloadPath(cacheDir, pin.sha256, options.kind);
  if (cachedImage(finalPath, pin)) return finalPath;
  await FSP.mkdir(cacheDir, { recursive: true, mode: 0o700 });
  const release = await (options.lock ?? acquireFileLock)(
    `${finalPath}.lock`,
    options.signal ?? new AbortController().signal,
  );
  try {
    // Another supervisor may have finished it while this one waited.
    if (cachedImage(finalPath, pin)) return finalPath;
    await FSP.rm(finalPath, { force: true });
    return await downloadLocked(options, finalPath);
  } finally {
    release();
  }
}

/** A pinned file held under its digest's lock, so no pruner removes it while it is used. */
export interface PinnedDownloadLease {
  readonly path: string;
  /** Idempotent. */
  release(): void;
}

/** True when the cached file's SHA-256 matches the pin; size is checked first. */
async function verifiedCache(finalPath: string, pin: GuestImagePin): Promise<boolean> {
  if (!cachedImage(finalPath, pin)) return false;
  const hash = Crypto.createHash("sha256");
  await hashFile(finalPath, hash);
  return hash.digest("hex") === pin.sha256;
}

/**
 * The pinned file for a caller about to hand it to Lima, under its digest's lock until the
 * caller releases it. `prunePinnedDownloads` skips a held digest, so another F5 build
 * sharing the cache can't remove the file mid-use. A cached file is hashed again first: a
 * file of the right size but wrong content (disk corruption, a foreign write) is replaced
 * instead of failing every retry at the guest's own digest check.
 */
export async function leasePinnedDownload(
  options: EnsurePinnedDownloadOptions,
): Promise<PinnedDownloadLease> {
  const { pin, cacheDir } = options;
  const finalPath = pinnedDownloadPath(cacheDir, pin.sha256, options.kind);
  await FSP.mkdir(cacheDir, { recursive: true, mode: 0o700 });
  const release = await (options.lock ?? acquireFileLock)(
    `${finalPath}.lock`,
    options.signal ?? new AbortController().signal,
  );
  try {
    if (!(await verifiedCache(finalPath, pin))) {
      await FSP.rm(finalPath, { force: true });
      await downloadLocked(options, finalPath);
    }
    return { path: finalPath, release };
  } catch (error) {
    release();
    throw error;
  }
}

/** Writes all of `chunk`: a single write may store only part of it. */
async function writeFully(file: FSP.FileHandle, chunk: Uint8Array, label: string): Promise<void> {
  let offset = 0;
  while (offset < chunk.byteLength) {
    const { bytesWritten } = await file.write(chunk, offset, chunk.byteLength - offset);
    if (bytesWritten <= 0) throw new GuestImageError(`Writing the ${label} made no progress.`);
    offset += bytesWritten;
  }
}

/** The download itself; the caller holds the digest's lock. */
async function downloadLocked(
  options: EnsurePinnedDownloadOptions,
  finalPath: string,
): Promise<string> {
  const { pin } = options;
  const { label } = options.kind;
  const fetchImpl = options.fetch ?? fetch;
  const partPath = `${finalPath}.part`;

  const hash = Crypto.createHash("sha256");
  let offset = 0;
  try {
    offset = await hashFile(partPath, hash);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (offset > pin.size) {
    await FSP.rm(partPath, { force: true });
    return downloadLocked(options, finalPath);
  }

  if (offset < pin.size) {
    const response = await fetchImpl(pin.url, {
      redirect: "follow",
      ...(offset > 0 ? { headers: { Range: `bytes=${offset}-` } } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    });
    if (offset > 0 && response.status === 416) {
      // The server rejects the saved range, not necessarily a full request: start over.
      hash.destroy();
      await response.body?.cancel().catch(() => undefined);
      await FSP.rm(partPath, { force: true });
      return downloadLocked(options, finalPath);
    }
    let resumed = false;
    if (offset > 0 && response.status === 206) {
      const range = /^bytes (\d+)-\d+\/(\d+|\*)$/.exec(response.headers.get("content-range") ?? "");
      resumed = range !== null && Number(range[1]) === offset;
    }
    if (!response.ok || !response.body)
      throw new GuestImageError(`The ${label} download failed (HTTP ${response.status}).`);
    if (!resumed && offset > 0) {
      // The server ignored the range: start over from the first byte.
      hash.destroy();
      await response.body.cancel().catch(() => undefined);
      await FSP.rm(partPath, { force: true });
      return downloadLocked(options, finalPath);
    }
    const file = await FSP.open(partPath, resumed ? "a" : "w", 0o600);
    let received = offset;
    try {
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        received += chunk.byteLength;
        if (received > pin.size)
          throw new GuestImageError(`The ${label} download is larger than its pin.`);
        await writeFully(file, chunk, label);
        hash.update(chunk);
        options.onProgress?.({ receivedBytes: received, totalBytes: pin.size });
      }
      await file.sync();
    } finally {
      await file.close();
    }
    if (received !== pin.size)
      throw new GuestImageError(`The ${label} download ended early; it will resume.`);
  }

  const digest = hash.digest("hex");
  if (digest !== pin.sha256) {
    await FSP.rm(partPath, { force: true });
    throw new GuestImageError(`The ${label} failed digest verification and was discarded.`);
  }
  await FSP.rename(partPath, finalPath);
  return finalPath;
}

/** Removes cached guest images other than `keepSha256`; see `prunePinnedDownloads`. */
export const pruneGuestImages = (
  cacheDir: string,
  keepSha256: string,
  lock: AcquireLock = acquireFileLock,
): Promise<void> => prunePinnedDownloads(cacheDir, keepSha256, GUEST_IMAGE, lock);

/**
 * Removes cached files of `kind` other than `keepSha256`, and abandoned partial downloads
 * of them. Each digest's files go only under its lock, taken without waiting: a digest
 * someone is downloading or leasing right now (another F5 build sharing the cache) is
 * skipped.
 */
export async function prunePinnedDownloads(
  cacheDir: string,
  keepSha256: string,
  kind: PinnedDownloadKind,
  lock: AcquireLock = acquireFileLock,
): Promise<void> {
  let names: string[];
  try {
    names = await FSP.readdir(cacheDir);
  } catch {
    return;
  }
  const extension = kind.extension.replaceAll(".", "\\.");
  const pattern = new RegExp(`^([0-9a-f]{64})${extension}(\\.part)?$`);
  const digests = new Set(
    names
      .map((name) => pattern.exec(name)?.[1])
      .filter((digest): digest is string => digest !== undefined && digest !== keepSha256),
  );
  for (const digest of digests) {
    const finalPath = pinnedDownloadPath(cacheDir, digest, kind);
    let release: () => void;
    try {
      release = await lock(`${finalPath}.lock`, new AbortController().signal, { waitMs: 0 });
    } catch (error) {
      if (error instanceof LockHeld) continue;
      throw error;
    }
    try {
      await FSP.rm(finalPath, { force: true });
      await FSP.rm(`${finalPath}.part`, { force: true });
    } finally {
      release();
    }
  }
}
