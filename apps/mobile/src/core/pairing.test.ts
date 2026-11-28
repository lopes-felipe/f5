import { describe, expect, it } from "vitest";
import { manualPairing, parsePairingUrl } from "./pairing";

const payload =
  "f5://pair?v=1&o=http%3A%2F%2Fhost.tailnet.ts.net%3A37730&o2=http%3A%2F%2F100.64.1.2%3A37730&c=ABCDEFG234&s=12345678901234567890123456789012&n=Work";

describe("F5 pairing", () => {
  it("keeps the advertised origin, numeric fallback, and server identity", () => {
    expect(parsePairingUrl(payload)).toEqual({
      origins: ["http://host.tailnet.ts.net:37730", "http://100.64.1.2:37730"],
      code: "ABCDEFG234",
      serverId: "12345678901234567890123456789012",
      profileName: "Work",
    });
  });

  it("requires an unambiguous F5 origin and code before confirmation", () => {
    expect(() => parsePairingUrl(payload + "&c=HGFEDCB234")).toThrow();
    expect(() => parsePairingUrl(payload.replace("f5://", "t3code://"))).toThrow();
    expect(() =>
      manualPairing("https://tailnet.ts.net.evil.example:37730", "ABCDEFG234"),
    ).toThrow();
    expect(() => manualPairing("http://host.tailnet.ts.net:37730/path", "ABCDEFG234")).toThrow();
    expect(() => manualPairing("192.168.0.1:37730", "ABCDEFG234")).toThrow();
    expect(manualPairing("100.127.8.1:37730", "abcdefg234")).toEqual({
      origins: ["http://100.127.8.1:37730"],
      code: "ABCDEFG234",
    });
  });
});
