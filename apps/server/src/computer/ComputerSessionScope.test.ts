import { describe, expect, it, vi } from "vitest";
import { computerHostFixture } from "../../integration/computer/hostFixture";
import { createComputerSessionScope } from "./ComputerSessionScope";

describe("shared computer session scope", () => {
  it("clears geometry and rejects stale finalizers without releasing a replacement generation", async () => {
    const fixture = await computerHostFixture();
    const threadId = "scope-thread";
    try {
      const first = createComputerSessionScope({
        broker: fixture.broker,
        threadId,
        provider: "codex",
        serverName: "scope-first",
      });
      const oldGeometry = first.geometry;
      first.resetConnection();
      expect(first.geometry).not.toBe(oldGeometry);
      const second = createComputerSessionScope({
        broker: fixture.broker,
        threadId,
        provider: "codex",
        serverName: "scope-second",
      });
      first.dispose();
      first.dispose();
      first.endTurn("test-turn");
      expect(fixture.broker.generation(threadId)).toBe(second.generation);
      second.dispose();
      expect(fixture.broker.generation(threadId)).toBeUndefined();
    } finally {
      fixture.broker.close();
    }
  });
  it("refuses new identities on a legacy desktop without impersonating another agent", async () => {
    const fixture = await computerHostFixture();
    try {
      // The fixture is a legacy desktop unless it explicitly negotiates capabilities.
      expect(() =>
        createComputerSessionScope({
          broker: fixture.broker,
          threadId: "cursor-thread",
          provider: "cursor",
          serverName: "scope-cursor",
        }),
      ).toThrow("Update F5");
      expect(fixture.broker.generation("cursor-thread")).toBeUndefined();
    } finally {
      fixture.broker.close();
    }
  });
});

it("joins a mutation retry after its own invalidation and preserves resolved apps", async () => {
  const fixture = await computerHostFixture();
  let release!: () => void;
  let admitted!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    admitted = resolve;
  });
  const scope = createComputerSessionScope({
    broker: fixture.broker,
    threadId: "scope-thread",
    provider: "codex",
    serverName: "retry-scope",
  });
  const original = fixture.broker.host.request.bind(fixture.broker.host);
  const spy = vi.spyOn(fixture.broker.host, "request").mockImplementation(async (request) => {
    const result = await original(request);
    if (request.op === "click") {
      admitted();
      await held;
    }
    return result;
  });
  try {
    await scope.call("computer_request_access", {
      apps: ["F5 transport test app"],
      reason: "Protocol integration",
    });
    await scope.call("computer_screenshot", {});
    const input = { x: 0, y: 0 };
    const first = scope.call("computer_click", input, "one-invocation");
    await Promise.race([
      started,
      first.then((result) => {
        throw new Error(JSON.stringify(result));
      }),
    ]);
    const retry = scope.call("computer_click", input, "one-invocation");
    release();
    const [result, duplicate] = await Promise.all([first, retry]);
    expect(result.isError).toBeFalsy();
    expect(duplicate).toEqual(result);
    expect(fixture.seen.filter((request) => request.op === "click")).toHaveLength(1);
    spy.mockRestore();
    const next = await scope.call("computer_click", input, "next-invocation");
    expect(next.isError).toBeFalsy();
    expect(
      (await scope.call("computer_type", { app: "F5 transport test app", text: "first" })).isError,
    ).toBeFalsy();
    expect(
      (await scope.call("computer_type", { app: "F5 transport test app", text: "second" })).isError,
    ).toBeFalsy();
    // One resolution for access, one for the first named call; none after action invalidation.
    expect(fixture.seen.filter((request) => request.op === "resolveApps")).toHaveLength(2);
  } finally {
    release();
    spy.mockRestore();
    scope.dispose();
    fixture.broker.close();
  }
});
