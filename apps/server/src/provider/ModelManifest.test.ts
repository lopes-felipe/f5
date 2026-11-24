import { describe, expect, it, vi } from "vitest";
import {
  BUNDLED_MODEL_MANIFEST,
  MODEL_MANIFEST_URL,
  classifyModelManifest,
  makeModelManifest,
} from "./ModelManifest.ts";
import type { ServerProvider } from "@t3tools/contracts";

const remote = {
  version: 1 as const,
  updatedAt: "2099-01-01T00:00:00Z",
  currentModels: { codex: ["future"] },
};
const noCache = async (): Promise<string> => {
  throw new Error("missing");
};

describe("model manifest", () => {
  it("classifies built-in models and preserves custom and unrelated models", () => {
    const provider = {
      driver: "codex",
      models: [
        { slug: "future", isCustom: false },
        { slug: "openai/gpt-5.2", isCustom: false },
        { slug: "newly-released", isCustom: false },
        { slug: "mine", isCustom: true },
      ],
    } as unknown as ServerProvider;
    expect(classifyModelManifest(provider, remote).models.map((model) => model.isLegacy)).toEqual([
      false,
      true,
      undefined,
      undefined,
    ]);
    const other = { ...provider, driver: "cursor" } as ServerProvider;
    expect(classifyModelManifest(other, remote)).toBe(other);
  });
  it("does not fetch automatically, coalesces refreshes, and caches accepted data", async () => {
    const fetch = vi.fn<(...args: Parameters<typeof globalThis.fetch>) => Promise<Response>>(
      async () => new Response(JSON.stringify(remote)),
    );
    const writeCache = vi.fn(async (_text: string) => undefined);
    const service = await makeModelManifest({
      cachePath: "/unused",
      fetch,
      readCache: noCache,
      writeCache,
    });
    service.refreshInBackground(false);
    expect(fetch).not.toHaveBeenCalled();
    expect(service.current()).toEqual(BUNDLED_MODEL_MANIFEST);
    service.refreshInBackground(true);
    service.refreshInBackground(true);
    await service.settled();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(service.current()).toEqual(remote);
    expect(JSON.parse(writeCache.mock.calls[0]![0]!)).toMatchObject({
      source: MODEL_MANIFEST_URL,
      manifest: remote,
    });
    service.refreshInBackground(true);
    await service.settled();
    expect(fetch).toHaveBeenCalledTimes(1);
    service.close();
  });
  it("keeps a stale disk cache while offline and throttles failures", async () => {
    let now = 20_000_000;
    const fetch = vi.fn<(...args: Parameters<typeof globalThis.fetch>) => Promise<Response>>(
      async () => {
        throw new Error("offline");
      },
    );
    const service = await makeModelManifest({
      cachePath: "/unused",
      fetch,
      now: () => now,
      readCache: async () =>
        JSON.stringify({ source: MODEL_MANIFEST_URL, fetchedAtMs: 1, manifest: remote }),
    });
    service.refreshInBackground(true);
    await service.settled();
    expect(service.current()).toEqual(remote);
    service.refreshInBackground(true);
    await service.settled();
    expect(fetch).toHaveBeenCalledTimes(1);
    now += 5 * 60_000;
    service.refreshInBackground(true);
    await service.settled();
    expect(fetch).toHaveBeenCalledTimes(2);
    service.close();
  });
  it("rejects incompatible remote data and older disk data", async () => {
    const service = await makeModelManifest({
      cachePath: "/unused",
      readCache: async () =>
        JSON.stringify({
          source: MODEL_MANIFEST_URL,
          fetchedAtMs: 1,
          manifest: { ...remote, updatedAt: "2000-01-01" },
        }),
      fetch: async () => new Response(JSON.stringify({ ...remote, version: 2 })),
    });
    expect(service.current()).toEqual(BUNDLED_MODEL_MANIFEST);
    service.refreshInBackground(true);
    await service.settled();
    expect(service.current()).toEqual(BUNDLED_MODEL_MANIFEST);
    service.close();
  });
  it.each([
    undefined,
    "https://raw.githubusercontent.com/pingdotgg/t3code/main/apps/server/src/provider/model-manifest.json",
  ])("ignores classifications cached without the current source: %s", async (source) => {
    const service = await makeModelManifest({
      cachePath: "/unused",
      readCache: async () => JSON.stringify({ source, fetchedAtMs: Date.now(), manifest: remote }),
    });
    expect(service.current()).toEqual(BUNDLED_MODEL_MANIFEST);
    service.close();
  });
  it("does not block reads behind a slow fetch and aborts at shutdown", async () => {
    let signal: AbortSignal | undefined;
    const service = await makeModelManifest({
      cachePath: "/unused",
      readCache: noCache,
      fetch: async (_url, init) => {
        signal = init?.signal as AbortSignal;
        return new Promise((_resolve, reject) =>
          signal!.addEventListener("abort", () => reject(new Error("aborted"))),
        );
      },
    });
    service.refreshInBackground(true);
    expect(service.current()).toEqual(BUNDLED_MODEL_MANIFEST);
    service.close();
    expect(signal?.aborted).toBe(true);
    await service.settled();
  });
  it("waits for a cache write to settle before releasing its state directory", async () => {
    let release!: () => void, started!: () => void;
    const writing = new Promise<void>((resolve) => {
      started = resolve;
    });
    const finish = new Promise<void>((resolve) => {
      release = resolve;
    });
    const service = await makeModelManifest({
      cachePath: "/unused",
      readCache: noCache,
      fetch: async () => new Response(JSON.stringify(remote)),
      writeCache: async () => {
        started();
        await finish;
      },
    });
    service.refreshInBackground(true);
    await writing;
    let closed = false;
    const closing = service.close().then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    release();
    await closing;
    expect(closed).toBe(true);
  });
});
