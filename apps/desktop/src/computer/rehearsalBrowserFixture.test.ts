import { expect, it } from "vitest";
import { createBrowserProtectionFixture } from "./rehearsalBrowserFixture";

it("isolates fixtures and accepts only bounded independent observations", async () => {
  const first = await createBrowserProtectionFixture();
  const second = await createBrowserProtectionFixture();
  try {
    const url = new URL(first.url);
    expect(url.hostname).toBe("127.0.0.1");
    expect((await fetch(first.url)).status).toBe(200);
    expect((await fetch(new URL("/unknown", first.url))).status).toBe(404);
    expect((await fetch(new URL(url.pathname, second.url))).status).toBe(404);
    const stateUrl = first.url.replace(/\/fixture$/, "/state");
    expect((await fetch(stateUrl, { method: "POST", body: '{"ready":true}' })).status).toBe(400);
    expect(first.state()).toBeUndefined();
    const state = { ready: true, secureFocused: true, secureUnchanged: true, inputEvents: 0 };
    expect(
      (
        await fetch(stateUrl, {
          method: "POST",
          body: JSON.stringify({ ...state, value: "PRIVATE_SENTINEL" }),
        })
      ).status,
    ).toBe(204);
    expect(first.state()).toEqual(state);
    expect(first.lastObservationAt()).toBeGreaterThan(0);
    expect(first.observation()).toEqual({
      pageRequested: true,
      stateReported: true,
      stateRejected: true,
    });
    expect(second.observation()).toEqual({
      pageRequested: false,
      stateReported: false,
      stateRejected: false,
    });
  } finally {
    await first.close();
    await second.close();
  }
});
