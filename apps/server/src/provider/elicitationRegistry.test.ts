import { ApprovalRequestId, TurnId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  ElicitationDeliveryUncertainError,
  ElicitationRegistry,
  type ElicitationResponse,
} from "./elicitationRegistry.ts";

const requestId = ApprovalRequestId.makeUnsafe("req-1");
const turnId = TurnId.makeUnsafe("turn-1");
const descriptor = {
  mode: "form" as const,
  message: "Who are you?",
  fields: [{ key: "name", title: "Name", required: true, type: "string" as const }],
};

describe("ElicitationRegistry", () => {
  it("validates, delivers once and refuses a second submission", async () => {
    const registry = new ElicitationRegistry();
    const delivered: ElicitationResponse[] = [];
    registry.open({
      requestId,
      descriptor,
      turnId,
      deliver: async (response) => void delivered.push(response),
    });
    await expect(registry.submit(requestId, { action: "accept", content: {} })).rejects.toThrow(
      '"Name" is required',
    );
    expect(delivered).toEqual([]);
    await expect(
      registry.submit(requestId, { action: "accept", content: { name: "sentinel-7f3a" } }),
    ).resolves.toBe("submitted");
    expect(delivered).toEqual([{ action: "accept", content: { name: "sentinel-7f3a" } }]);
    await expect(registry.submit(requestId, { action: "cancel" })).rejects.toThrow(
      "never sends an answer twice",
    );
    expect(registry.forTurn(turnId)).toEqual([requestId]);
    expect(registry.settle(requestId, "completed")).toBe("resolved");
    expect(registry.has(requestId)).toBe(false);
  });

  it("keeps a request pending when delivery fails before leaving F5", async () => {
    const registry = new ElicitationRegistry();
    const deliver = vi
      .fn<(response: ElicitationResponse) => Promise<void>>()
      .mockRejectedValueOnce(new Error("not connected"))
      .mockResolvedValueOnce();
    registry.open({ requestId, descriptor, deliver });
    await expect(registry.submit(requestId, { action: "decline" })).rejects.toThrow(
      "not connected",
    );
    await expect(registry.submit(requestId, { action: "decline" })).resolves.toBe("submitted");
  });

  it("marks uncertain deliveries indeterminate and never retries them", async () => {
    const registry = new ElicitationRegistry();
    const deliver = vi.fn(async () => {
      throw new ElicitationDeliveryUncertainError();
    });
    registry.open({ requestId, descriptor, deliver });
    await expect(
      registry.submit(requestId, { action: "accept", content: { name: "x" } }),
    ).rejects.toBeInstanceOf(ElicitationDeliveryUncertainError);
    await expect(registry.submit(requestId, { action: "cancel" })).rejects.toThrow("twice");
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(registry.abortAll()).toEqual([{ requestId, receipt: "indeterminate" }]);
  });

  it("cancels unanswered requests and releases the waiting provider callback", () => {
    const registry = new ElicitationRegistry();
    const abort = vi.fn();
    registry.open({ requestId, descriptor, deliver: async () => {}, abort });
    expect(registry.abortAll()).toEqual([{ requestId, receipt: "cancelled" }]);
    expect(abort).toHaveBeenCalledOnce();
  });

  it("settles a delivered decline or cancel as cancelled, not resolved", async () => {
    for (const action of ["decline", "cancel"] as const) {
      const registry = new ElicitationRegistry();
      registry.open({ requestId, descriptor, deliver: async () => {} });
      await registry.submit(requestId, { action });
      // A JSON-RPC transport settles later, on the provider's completion.
      expect(registry.settleIfDelivered(requestId)).toBeUndefined();
      expect(registry.settle(requestId, "completed")).toBe("cancelled");
    }
  });

  it("settles in-process deliveries at once, except an accepted link", async () => {
    const registry = new ElicitationRegistry();
    registry.open({ requestId, descriptor, deliver: async () => {}, completesOnDelivery: true });
    await registry.submit(requestId, { action: "accept", content: { name: "x" } });
    expect(registry.settleIfDelivered(requestId)).toBe("resolved");
    expect(registry.abortAll()).toEqual([]);

    const link = ApprovalRequestId.makeUnsafe("req-link");
    const declined = ApprovalRequestId.makeUnsafe("req-link-declined");
    for (const id of [link, declined])
      registry.open({
        requestId: id,
        descriptor: { mode: "url", message: "Sign in", url: "https://x.test" },
        deliver: async () => {},
        completesOnDelivery: true,
      });
    await registry.submit(link, { action: "accept" });
    await registry.submit(declined, { action: "decline" });
    // An accepted link completes only when the provider reports the flow done.
    expect(registry.settleIfDelivered(link)).toBeUndefined();
    expect(registry.settleIfDelivered(declined)).toBe("cancelled");
    expect(registry.has(link)).toBe(true);
  });

  it("refuses values for link requests and finds them by native id", async () => {
    const registry = new ElicitationRegistry();
    registry.open({
      requestId,
      descriptor: { mode: "url", message: "Sign in", url: "https://x.test", nativeId: "el-9" },
      deliver: async () => {},
    });
    expect(registry.findByNativeId("el-9")).toBe(requestId);
    await expect(
      registry.submit(requestId, { action: "accept", content: { token: "x" } }),
    ).rejects.toThrow("does not take form values");
    await expect(registry.submit(requestId, { action: "accept" })).resolves.toBe("submitted");
  });
});
