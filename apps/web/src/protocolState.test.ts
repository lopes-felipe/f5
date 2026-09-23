import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { F5_PROTOCOL_HEADER, F5_PROTOCOL_VERSION } from "@t3tools/contracts";
import {
  beginProtocolUpload,
  getProtocolState,
  getServerSendLimits,
  protocolFetch,
  requireProtocolUpgrade,
  resetProtocolStateForTests,
  setServerBootstrap,
} from "./protocolState";
import { serverBootstrapFixture } from "./test/serverBootstrap";

beforeEach(resetProtocolStateForTests);
afterEach(() => vi.unstubAllGlobals());

describe("protocol state", () => {
  it("uses server-advertised limits instead of compiled client limits", () => {
    expect(() => getServerSendLimits()).toThrow("Waiting for server capabilities");
    setServerBootstrap({
      ...serverBootstrapFixture,
      sendLimits: { ...serverBootstrapFixture.sendLimits, maxImagesPerTurn: 3 },
      providerSendLimits: {
        ...serverBootstrapFixture.providerSendLimits,
        codex: { ...serverBootstrapFixture.sendLimits, maxInputChars: 42 },
      },
    });
    expect(getServerSendLimits().maxImagesPerTurn).toBe(3);
    expect(getServerSendLimits("codex").maxInputChars).toBe(42);
  });
  it("preserves existing uploads, rejects new uploads and releases each lease once", () => {
    const one = beginProtocolUpload();
    const two = beginProtocolUpload();
    requireProtocolUpgrade();
    expect(() => beginProtocolUpload()).toThrow("F5 was updated");
    expect(getProtocolState().activeUploads).toBe(2);
    one();
    one();
    expect(getProtocolState().activeUploads).toBe(1);
    two();
    expect(getProtocolState().activeUploads).toBe(0);
  });
  it("sends the protocol header and stops after a 426 without retrying a mutation", async () => {
    const fetcher = vi.fn(
      async () => new Response(JSON.stringify({ error: "upgrade-required" }), { status: 426 }),
    );
    vi.stubGlobal("fetch", fetcher);
    await expect(
      protocolFetch("/api/storage/restore", {
        method: "POST",
        headers: { "Content-Type": "application/x-f5-backup" },
        body: "archive",
      }),
    ).rejects.toThrow("F5 was updated");
    const init = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(new Headers(init[1].headers).get(F5_PROTOCOL_HEADER)).toBe(String(F5_PROTOCOL_VERSION));
    expect(new Headers(init[1].headers).get("Content-Type")).toBe("application/x-f5-backup");
    await expect(protocolFetch("/api/storage/restore", { method: "POST" })).rejects.toThrow(
      "F5 was updated",
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
