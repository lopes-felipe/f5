import { describe, expect, it } from "vitest";
import { markerTitle, startMutationServer, stoppedAfter } from "./mutation-fixture.ts";

describe("mutation fixture server", () => {
  it("records loads and mutations per marker on loopback only", async () => {
    let clock = 100;
    const server = await startMutationServer(() => clock++);
    try {
      expect(server.origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      const page = await fetch(`${server.origin}/marker/alpha`);
      expect(await page.text()).toContain(`<title>${markerTitle("alpha")}</title>`);
      expect((await fetch(`${server.origin}/mutate/alpha`, { method: "POST" })).status).toBe(204);
      expect((await fetch(`${server.origin}/mutate/beta`, { method: "POST" })).status).toBe(204);
      expect(server.hits("alpha")).toEqual([100, 101]);
      expect(server.mutations("alpha")).toEqual([101]);
      expect(server.mutations("beta")).toEqual([102]);
      // Mutations need POST; unknown paths and markers are refused and not counted.
      expect((await fetch(`${server.origin}/mutate/alpha`)).status).toBe(404);
      expect((await fetch(`${server.origin}/marker/a%20b`)).status).toBe(404);
      expect((await fetch(`${server.origin}/other/alpha`)).status).toBe(404);
      expect(server.hits("alpha")).toHaveLength(2);
    } finally {
      await server.close();
    }
  });
});

describe("stoppedAfter", () => {
  const running = [0, 100, 200, 300];
  it("passes when running work goes quiet for the whole window", () => {
    expect(stoppedAfter([...running, 1500], 400, 7400)).toBe(true);
  });
  it("fails without a positive control", () => {
    expect(stoppedAfter([300], 400, 7400)).toBe(false);
  });
  it("fails when work lands after the settle window", () => {
    expect(stoppedAfter([...running, 2500], 400, 7400)).toBe(false);
    expect(stoppedAfter([...running, 7000], 400, 7400)).toBe(false);
  });
  it("fails when the observation ended early", () => {
    expect(stoppedAfter(running, 400, 7000)).toBe(false);
  });
});
