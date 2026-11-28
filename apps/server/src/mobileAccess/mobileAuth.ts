import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const TTL_MS = 5 * 60_000;
const RATE_WINDOW_MS = 60_000;
const SOURCE_LIMIT = 5;
const GLOBAL_LIMIT = 100;

export function hashMobileToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function makeMobileAuth<Device extends { readonly token_hash: string }>(
  devicesByHash: ReadonlyMap<string, Device>,
  now = Date.now,
) {
  const codes = new Map<string, number>();
  const failures = new Map<string, number[]>();
  let globalFailures: number[] = [];

  function expireCodes() {
    for (const [code, expiresAt] of codes) {
      if (expiresAt <= now()) codes.delete(code);
    }
  }

  return {
    authenticate(authorization: string | undefined): Device | undefined {
      const match = /^Bearer ([a-zA-Z0-9_-]{43})$/.exec(authorization ?? "");
      if (!match?.[1]) return undefined;
      const hash = hashMobileToken(match[1]);
      const device = devicesByHash.get(hash);
      return device &&
        timingSafeEqual(Buffer.from(hash, "hex"), Buffer.from(device.token_hash, "hex"))
        ? device
        : undefined;
    },
    createCode() {
      expireCodes();
      let code: string;
      do {
        code = Array.from(randomBytes(10), (byte) => BASE32.charAt(byte & 31)).join("");
      } while (codes.has(code));
      if (codes.size >= 5) {
        const oldest = codes.keys().next().value;
        if (oldest !== undefined) codes.delete(oldest);
      }
      const expiresAt = now() + TTL_MS;
      codes.set(code, expiresAt);
      return { code, expiresAt };
    },
    consumeCode(code: string) {
      expireCodes();
      return codes.delete(code);
    },
    clearCodes() {
      codes.clear();
    },
    retryAfter(source: string) {
      const current = now();
      const cutoff = current - RATE_WINDOW_MS;
      globalFailures = globalFailures.filter((at) => at > cutoff);
      // The global budget bounds the size of this map even for rotating IPs.
      for (const [key, timestamps] of failures) {
        const active = timestamps.filter((at) => at > cutoff);
        if (active.length === 0) failures.delete(key);
        else failures.set(key, active);
      }
      const local = failures.get(source) ?? [];
      const blockedUntil = Math.max(
        local.length >= SOURCE_LIMIT ? (local[0] ?? cutoff) + RATE_WINDOW_MS : 0,
        globalFailures.length >= GLOBAL_LIMIT ? (globalFailures[0] ?? cutoff) + RATE_WINDOW_MS : 0,
      );
      return Math.max(0, Math.ceil((blockedUntil - current) / 1000));
    },
    recordFailure(source: string) {
      const current = now();
      globalFailures.push(current);
      const local = failures.get(source) ?? [];
      local.push(current);
      failures.set(source, local);
    },
  };
}
