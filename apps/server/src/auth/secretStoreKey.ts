import * as Crypto from "node:crypto";

/**
 * Desktop main hands each profile backend a 32-byte master key, unwrapped with
 * the OS keychain, in this variable. The backend reads it once at startup and
 * removes it from its own environment.
 */
export const SECRET_STORE_KEY_ENV = "F5_SECRET_STORE_KEY";

/** Secret names whose values are encrypted at rest. */
export const ENCRYPTED_SECRET_PREFIXES = ["mcp-secret-", "mcp-oauth-", "mobile-apns-p8"] as const;

/** Holds the headless fallback key; it never matches an encrypted prefix. */
export const SECRET_STORE_KEY_FILE = "secret-store-key";

const MAGIC = Buffer.from("F5S1", "ascii");
const IV_BYTES = 12;
const TAG_BYTES = 16;

export function parseSecretStoreKey(value: string | undefined): Uint8Array | undefined {
  const trimmed = value?.trim();
  return trimmed && /^[0-9a-f]{64}$/iu.test(trimmed)
    ? Uint8Array.from(Buffer.from(trimmed, "hex"))
    : undefined;
}

export function isEncryptedSecretName(name: string): boolean {
  return ENCRYPTED_SECRET_PREFIXES.some((prefix) => name.startsWith(prefix));
}

export function isEncryptedSecretValue(bytes: Uint8Array): boolean {
  return (
    bytes.length >= MAGIC.length + IV_BYTES + TAG_BYTES &&
    Buffer.from(bytes.subarray(0, MAGIC.length)).equals(MAGIC)
  );
}

/** AES-256-GCM; the secret's name is authenticated, so a file cannot be swapped for another. */
export function encryptSecretValue(key: Uint8Array, name: string, plain: Uint8Array): Uint8Array {
  const iv = Crypto.randomBytes(IV_BYTES);
  const cipher = Crypto.createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(name, "utf8"));
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Uint8Array.from(Buffer.concat([MAGIC, iv, body, cipher.getAuthTag()]));
}

/** Returns null when this key did not encrypt the value or the value was altered. */
export function decryptSecretValue(
  key: Uint8Array,
  name: string,
  bytes: Uint8Array,
): Uint8Array | null {
  if (!isEncryptedSecretValue(bytes)) return null;
  const data = Buffer.from(bytes);
  const iv = data.subarray(MAGIC.length, MAGIC.length + IV_BYTES);
  const tag = data.subarray(data.length - TAG_BYTES);
  const body = data.subarray(MAGIC.length + IV_BYTES, data.length - TAG_BYTES);
  try {
    const decipher = Crypto.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAAD(Buffer.from(name, "utf8"));
    decipher.setAuthTag(tag);
    return Uint8Array.from(Buffer.concat([decipher.update(body), decipher.final()]));
  } catch {
    return null;
  }
}
