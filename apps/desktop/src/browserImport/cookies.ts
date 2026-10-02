import { createDecipheriv, createHash, pbkdf2Sync } from "node:crypto";
import type { CookiesSetDetails } from "electron";
export type ImportedCookie = CookiesSetDetails;
export function cookieScope(
  host: string,
  cookiePath: string,
  secure: boolean,
): { url: string; domain?: string } {
  const bare = host.startsWith(".") ? host.slice(1) : host;
  if (!bare || /[\s/@?#]/.test(bare) || !cookiePath.startsWith("/"))
    throw new Error("Invalid cookie scope.");
  const url = new URL(
    `${secure ? "https" : "http"}://${bare.includes(":") && !bare.startsWith("[") ? `[${bare}]` : bare}${cookiePath}`,
  ).href;
  return { url, ...(host.startsWith(".") ? { domain: host } : {}) };
}
export function chromiumKey(secret: string, platform: NodeJS.Platform): Buffer {
  return pbkdf2Sync(secret, "saltysalt", platform === "darwin" ? 1003 : 1, 16, "sha1");
}
export function decryptChromium(
  value: Uint8Array,
  host: string,
  version: number,
  keys: { v10?: Buffer; v11?: Buffer },
  platform: NodeJS.Platform,
): string {
  const bytes = Buffer.from(value),
    prefix = bytes.toString("ascii", 0, 3);
  if (prefix === "v20") throw new Error("App-bound encryption is unsupported.");
  const key = prefix === "v10" ? keys.v10 : prefix === "v11" ? keys.v11 : undefined;
  if (!key) throw new Error("Unsupported cookie encryption.");
  let plaintext: Buffer;
  if (platform === "win32") {
    if (bytes.length < 31) throw new Error("Invalid encrypted cookie.");
    const decipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(3, 15));
    decipher.setAuthTag(bytes.subarray(-16));
    plaintext = Buffer.concat([decipher.update(bytes.subarray(15, -16)), decipher.final()]);
  } else {
    const decipher = createDecipheriv("aes-128-cbc", key, Buffer.alloc(16, 32));
    plaintext = Buffer.concat([decipher.update(bytes.subarray(3)), decipher.final()]);
  }
  if (version >= 24) {
    const digest = createHash("sha256").update(host).digest();
    if (plaintext.length < 32 || !plaintext.subarray(0, 32).equals(digest))
      throw new Error("Invalid cookie host binding.");
    plaintext = plaintext.subarray(32);
  }
  return plaintext.toString("utf8");
}
