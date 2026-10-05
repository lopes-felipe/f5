import { createCipheriv, createHash } from "node:crypto";
import { describe, it, expect } from "vitest";
import { chromiumKey, decryptChromium, cookieScope } from "./cookies";
import { parseBinaryCookies } from "./safari";
function cbc(value: Buffer, key: Buffer, prefix = "v10") {
  const cipher = createCipheriv("aes-128-cbc", key, Buffer.alloc(16, 32));
  return Buffer.concat([Buffer.from(prefix), cipher.update(value), cipher.final()]);
}
describe("cookie encryption and scope", () => {
  it.each(["darwin", "linux"] as const)("decrypts %s OSCrypt CBC with host binding", (platform) => {
    const host = ".example.test",
      key = chromiumKey("synthetic-secret", platform),
      plain = Buffer.concat([
        createHash("sha256").update(host).digest(),
        Buffer.from("fixture-value"),
      ]);
    expect(decryptChromium(cbc(plain, key), host, 24, { v10: key }, platform)).toBe(
      "fixture-value",
    );
    expect(() =>
      decryptChromium(cbc(plain, key), "wrong.test", 24, { v10: key }, platform),
    ).toThrow("host binding");
    expect(
      decryptChromium(cbc(Buffer.from("legacy"), key), "example.test", 23, { v10: key }, platform),
    ).toBe("legacy");
  });
  it("decrypts standard Windows AES-GCM and rejects app-bound or corrupt encryption", () => {
    const key = Buffer.alloc(32, 7),
      nonce = Buffer.alloc(12, 3),
      cipher = createCipheriv("aes-256-gcm", key, nonce);
    const bytes = Buffer.concat([
      Buffer.from("v10"),
      nonce,
      cipher.update("synthetic"),
      cipher.final(),
      cipher.getAuthTag(),
    ]);
    expect(decryptChromium(bytes, "example.test", 23, { v10: key }, "win32")).toBe("synthetic");
    const corrupt = Buffer.from(bytes);
    corrupt[corrupt.length - 1] = corrupt[corrupt.length - 1]! ^ 1;
    expect(() => decryptChromium(corrupt, "example.test", 23, { v10: key }, "win32")).toThrow();
    expect(() =>
      decryptChromium(Buffer.from("v20anything"), "example.test", 23, { v10: key }, "win32"),
    ).toThrow("App-bound");
  });
  it("preserves host-only scope and rejects malformed domains", () => {
    expect(cookieScope("example.test", "/", true)).toEqual({ url: "https://example.test/" });
    expect(cookieScope(".example.test", "/app", true)).toEqual({
      url: "https://example.test/app",
      domain: ".example.test",
    });
    expect(() => cookieScope("evil.test/other", "/", true)).toThrow();
  });
  it("rejects corrupt Safari page tables and offsets", () => {
    expect(() => parseBinaryCookies(Buffer.from("broken"))).toThrow();
    const header = Buffer.alloc(8);
    header.write("cook");
    header.writeUInt32BE(99, 4);
    expect(() => parseBinaryCookies(header)).toThrow();
  });
});
