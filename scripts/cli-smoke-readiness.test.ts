import { afterEach, expect, it, vi } from "vitest";
import { waitForCliBootstrap } from "./cli-smoke-readiness.ts";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it("waits for listening after commit without repeating installation or handoff", async () => {
  vi.useFakeTimers();
  const fetch = vi
    .fn()
    .mockRejectedValueOnce(
      Object.assign(new TypeError("fetch failed"), {
        cause: { code: "ECONNREFUSED" },
      }),
    )
    .mockResolvedValueOnce(Response.json({ protocolVersion: 1 }));
  vi.stubGlobal("fetch", fetch);
  const result = waitForCliBootstrap(
    "http://127.0.0.1:1234",
    () => false,
    () => "",
  );
  await vi.advanceTimersByTimeAsync(250);
  await expect(result).resolves.toEqual({ protocolVersion: 1 });
  expect(fetch).toHaveBeenCalledTimes(2);
});

it("fails immediately on invalid bootstrap data or persistent HTTP failures", async () => {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(Response.json({}))
    .mockResolvedValueOnce(new Response("", { status: 500 }));
  vi.stubGlobal("fetch", fetch);
  await expect(
    waitForCliBootstrap(
      "http://localhost",
      () => false,
      () => "",
    ),
  ).rejects.toThrow("protocol");
  await expect(
    waitForCliBootstrap(
      "http://localhost",
      () => false,
      () => "",
    ),
  ).rejects.toThrow("HTTP 500");
  expect(fetch).toHaveBeenCalledTimes(2);
});

it("fails immediately when the owned process exits and includes diagnostics", async () => {
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  await expect(
    waitForCliBootstrap(
      "http://localhost",
      () => true,
      () => "migration failed",
    ),
  ).rejects.toThrow("migration failed");
  expect(fetch).not.toHaveBeenCalled();
});

it("bounds unavailable startup and preserves its diagnostics", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 503 })));
  const result = expect(
    waitForCliBootstrap(
      "http://localhost",
      () => false,
      () => "still migrating",
      500,
    ),
  ).rejects.toThrow("still migrating");
  await vi.advanceTimersByTimeAsync(500);
  await result;
});

it("does not retry trust or other unexpected transport failures", async () => {
  const failure = Object.assign(new TypeError("fetch failed"), {
    cause: { code: "DEPTH_ZERO_SELF_SIGNED_CERT" },
  });
  const fetch = vi.fn().mockRejectedValue(failure);
  vi.stubGlobal("fetch", fetch);
  await expect(
    waitForCliBootstrap(
      "http://localhost",
      () => false,
      () => "",
    ),
  ).rejects.toBe(failure);
  expect(fetch).toHaveBeenCalledTimes(1);
});
