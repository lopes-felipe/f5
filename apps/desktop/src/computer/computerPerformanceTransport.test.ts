import { expect, it, vi } from "vitest";
import { ComputerPerformanceTransport } from "./computerPerformanceTransport";
import type { ComputerController } from "./ComputerController";

function setup() {
  const invoke = vi.fn(async () => ({ actionCompleted: true }));
  const acquire = vi.fn((holder) => holder);
  const transport = new ComputerPerformanceTransport({
    profileId: "perf",
    allowedApps: new Set(["fixture"]),
    status: () => ({ available: true }),
    controller: {
      invoke,
      acquire,
      updateGrants: vi.fn(),
      prepareAcquisition: vi.fn(async () => {}),
      cancel: vi.fn(),
      setPaused: vi.fn(),
      invalidateThread: vi.fn(async () => {}),
    } as Pick<
      ComputerController,
      | "invoke"
      | "acquire"
      | "updateGrants"
      | "prepareAcquisition"
      | "cancel"
      | "setPaused"
      | "invalidateThread"
    >,
    lease: { release: vi.fn() },
    probe: () => {
      throw new Error("diagnostic callback");
    },
  });
  const authorization = {
    profileId: "perf",
    threadId: "thread",
    sessionGeneration: "session",
    turnId: "turn",
    executionGeneration: 1,
    grantVersion: 1,
    grants: [{ appId: "fixture", tier: "full", allowTyping: false }],
  };
  const request = (fields: Record<string, unknown>) => ({
    type: "request",
    request: {
      op: "type",
      text: "synthetic",
      appId: "fixture",
      requestId: "request",
      deadlineAtMs: Date.now() + 1000,
      payloadHash: "a".repeat(64),
      authorization,
      agent: { provider: "codex", threadTitle: "Synthetic fixture" },
      ...fields,
    },
  });
  const send = (message: unknown) =>
    new Promise<any>((resolve, reject) => {
      transport.once("message", resolve);
      transport.send(message, (error) => {
        if (error) reject(error);
      });
    });
  return { transport, invoke, acquire, authorization, request, send };
}
it("rejects foreign apps and grants without dispatching input", async () => {
  const h = setup();
  for (const fields of [
    { appId: "foreign" },
    { authorization: { ...h.authorization, profileId: "foreign" } },
    {
      authorization: {
        ...h.authorization,
        grants: [{ appId: "foreign", tier: "full", allowTyping: false }],
      },
    },
  ]) {
    expect(await h.send(h.request(fields))).toMatchObject({ error: { _tag: "Execution" } });
  }
  expect(h.invoke).not.toHaveBeenCalled();
  h.transport.close();
});
it("dispatches an allowed fixture request once and preserves its result", async () => {
  const h = setup();
  expect(await h.send(h.request({}))).toMatchObject({ result: { actionCompleted: true } });
  expect(h.invoke).toHaveBeenCalledTimes(1);
  h.transport.close();
});
it("cannot resolve private apps or acquire a takeover", async () => {
  const h = setup();
  expect(
    await h.send(
      h.request({ op: "resolveApps", queries: ["foreign"], text: undefined, appId: undefined }),
    ),
  ).toMatchObject({ error: { _tag: "Execution" } });
  expect(
    await h.send({
      type: "leaseAcquire",
      requestId: "lease",
      holder: {
        ...h.authorization,
        backend: "native",
        threadTitle: "Fixture",
        policyRevision: 0,
        scope: { kind: "takeover", appId: "fixture", approvalReceipt: "unapproved" },
      },
    }),
  ).toMatchObject({ error: { _tag: "Execution" } });
  expect(h.invoke).not.toHaveBeenCalled();
  expect(h.acquire).not.toHaveBeenCalled();
  h.transport.close();
});
it("counts fixture resolution and isolates throwing diagnostic callbacks", async () => {
  const h = setup();
  const result = await h.send(
    h.request({
      op: "resolveApps",
      queries: ["fixture"],
      text: undefined,
      appId: undefined,
    }),
  );
  expect(result).toMatchObject({ result: { actionCompleted: true } });
  expect(h.transport.resolutions).toBe(1);
  h.transport.close();
});
