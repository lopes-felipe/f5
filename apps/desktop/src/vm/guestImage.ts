import * as Crypto from "node:crypto";
import * as FS from "node:fs";
import * as FSP from "node:fs/promises";
import * as Path from "node:path";
import { acquireFileLock } from "./fileLock";

/** A guest image pinned by an F5 release (`apps/desktop/vm-guest/image.lock.json`). */
export interface GuestImagePin {
  readonly url: string;
  readonly sha256: string;
  readonly size: number;
}

export class GuestImageError extends Error {
  override readonly name = "GuestImageError";
}

/** Images are published only as GitHub release assets of this repository. */
const ALLOWED_IMAGE_URL = /^https:\/\/github\.com\/lopes-felipe\/f5\/releases\/download\/[^?#]+$/;

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
    : ALLOWED_IMAGE_URL.test(url);
  if (!allowed) throw new GuestImageError("The guest image pin has a disallowed URL.");
  return { url, sha256, size };
}

export interface GuestImageProgress {
  readonly receivedBytes: number;
  readonly totalBytes: number;
}

export interface EnsureGuestImageOptions {
  readonly pin: GuestImagePin;
  readonly cacheDir: string;
  readonly fetch?: typeof fetch;
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: GuestImageProgress) => void;
}

export const guestImagePath = (cacheDir: string, sha256: string) =>
  Path.join(cacheDir, `${sha256}.qcow2`);

async function hashFile(path: string, hash: Crypto.Hash): Promise<number> {
  let bytes = 0;
  for await (const chunk of FS.createReadStream(path)) {
    hash.update(chunk as Buffer);
    bytes += (chunk as Buffer).byteLength;
  }
  return bytes;
}

/** A cached image is usable when it exists with the pinned size; anything else is removed. */
function cachedImage(finalPath: string, pin: GuestImagePin): boolean {
  try {
    if (FS.statSync(finalPath).size === pin.size) return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  FS.rmSync(finalPath, { force: true });
  return false;
}

/**
 * The local path of the pinned image, downloading it if needed.
 *
 * Every VM profile's supervisor shares the cache, so one process at a time owns a digest's
 * download, from resume through rename, under `<digest>.qcow2.lock`; the others wait for
 * it and then find the finished file. A partial download resumes with a Range request; the
 * bytes already on disk are hashed again first, so a resumed file is verified end to end.
 * Only a file whose size and SHA-256 match the pin is renamed into place. The rename is
 * atomic and the cache sits in F5's own state directory, so a cached file with the pinned
 * size is trusted by name.
 */
export async function ensureGuestImage(options: EnsureGuestImageOptions): Promise<string> {
  const { pin, cacheDir } = options;
  const finalPath = guestImagePath(cacheDir, pin.sha256);
  if (cachedImage(finalPath, pin)) return finalPath;
  await FSP.mkdir(cacheDir, { recursive: true, mode: 0o700 });
  const release = await acquireFileLock(
    `${finalPath}.lock`,
    options.signal ?? new AbortController().signal,
  );
  try {
    // Another supervisor may have finished it while this one waited.
    if (cachedImage(finalPath, pin)) return finalPath;
    return await downloadLocked(options, finalPath);
  } finally {
    release();
  }
}

/** Writes all of `chunk`: a single write may store only part of it. */
async function writeFully(file: FSP.FileHandle, chunk: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < chunk.byteLength) {
    const { bytesWritten } = await file.write(chunk, offset, chunk.byteLength - offset);
    if (bytesWritten <= 0) throw new GuestImageError("Writing the guest image made no progress.");
    offset += bytesWritten;
  }
}

/** The download itself; the caller holds the digest's lock. */
async function downloadLocked(
  options: EnsureGuestImageOptions,
  finalPath: string,
): Promise<string> {
  const { pin } = options;
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
    let resumed = false;
    if (offset > 0 && response.status === 206) {
      const range = /^bytes (\d+)-\d+\/(\d+|\*)$/.exec(response.headers.get("content-range") ?? "");
      resumed = range !== null && Number(range[1]) === offset;
    }
    if (!response.ok || !response.body)
      throw new GuestImageError(`The guest image download failed (HTTP ${response.status}).`);
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
          throw new GuestImageError("The guest image download is larger than its pin.");
        await writeFully(file, chunk);
        hash.update(chunk);
        options.onProgress?.({ receivedBytes: received, totalBytes: pin.size });
      }
      await file.sync();
    } finally {
      await file.close();
    }
    if (received !== pin.size)
      throw new GuestImageError("The guest image download ended early; it will resume.");
  }

  const digest = hash.digest("hex");
  if (digest !== pin.sha256) {
    await FSP.rm(partPath, { force: true });
    throw new GuestImageError("The guest image failed digest verification and was discarded.");
  }
  await FSP.rename(partPath, finalPath);
  return finalPath;
}

/** Removes cached images other than `keepSha256`, and abandoned partial downloads of them. */
export async function pruneGuestImages(cacheDir: string, keepSha256: string): Promise<void> {
  let names: string[];
  try {
    names = await FSP.readdir(cacheDir);
  } catch {
    return;
  }
  await Promise.all(
    names
      .filter((name) => /^[0-9a-f]{64}\.qcow2(\.part)?$/.test(name))
      .filter((name) => !name.startsWith(keepSha256))
      .map((name) => FSP.rm(Path.join(cacheDir, name), { force: true })),
  );
}
