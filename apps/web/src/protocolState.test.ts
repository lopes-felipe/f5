import { compressImageForComposer } from "./lib/imageCompression";
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
  canAutoReloadForProtocolUpgrade,
  reloadForProtocolUpgrade,
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
    });
    expect(getServerSendLimits().maxImagesPerTurn).toBe(3);
    expect(getProtocolState().ready).toBe(true);
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

it("attempts only one automatic reload per client version, even across state resets", () => {
  const values = new Map<string, string>();
  vi.stubGlobal("sessionStorage", {
    getItem: (key: string) => values.get(key),
    setItem: (key: string, value: string) => values.set(key, value),
  });
  const reload = vi.fn();
  vi.stubGlobal("window", { location: { reload } });
  requireProtocolUpgrade();
  reloadForProtocolUpgrade();
  resetProtocolStateForTests();
  requireProtocolUpgrade();
  expect(canAutoReloadForProtocolUpgrade()).toBe(false);
  reloadForProtocolUpgrade();
  expect(reload).toHaveBeenCalledTimes(1);
});

it("does not report missing compression limits as a corrupt image", async () => {
  vi.stubGlobal("Worker", vi.fn());
  expect(
    await compressImageForComposer(new File(["image"], "clipboard.png", { type: "image/png" })),
  ).toEqual({ ok: false, reason: "not-ready" });
});
