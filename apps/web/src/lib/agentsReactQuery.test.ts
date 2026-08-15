import { describe, expect, it } from "vitest";

import { decodeAgentsSnapshot } from "./agentsReactQuery";

describe("decodeAgentsSnapshot", () => {
  it("accepts an empty durable snapshot", () => {
    expect(
      decodeAgentsSnapshot({
        entries: [],
        generatedAt: "2026-08-15T10:00:00.000Z",
      }),
    ).toEqual({
      entries: [],
      generatedAt: "2026-08-15T10:00:00.000Z",
    });
  });

  it("rejects malformed or pre-upgrade RPC responses before model derivation", () => {
    expect(() => decodeAgentsSnapshot({})).toThrow();
    expect(() => decodeAgentsSnapshot({ entries: "not-an-array" })).toThrow();
  });
});
