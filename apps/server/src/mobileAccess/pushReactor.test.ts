import { OrchestrationEvent } from "@t3tools/contracts";
import { Effect, Schema } from "effect";
import { afterEach, expect, it, vi } from "vitest";
import { makeMobilePushReactor } from "./pushReactor.ts";
import type { MobileDevice } from "./deviceStore.ts";
import fixtures from "../../../../packages/contracts/src/mobile/fixtures/v1/wire.json";

afterEach(() => vi.useRealTimers());

it("seeds silently, isolates retries and skips a resolved approval even after a presence lease expires", async () => {
  vi.useFakeTimers();
  const original = fixtures.methods.getThreadShells.response.threads[0]!;
  let approvalIds = ["old-approval"];
  const thread = () => ({
    ...original,
    attention: { ...original.attention, pendingApprovalRequestIds: approvalIds },
  });
  const device = (id: string): MobileDevice => ({
    device_id: id,
    name: id,
    bundle_id: "io.github.lopesfelipe.f5.mobile",
    platform: "ios",
    app_version: "0.1.0",
    token_hash: id,
    created_at: original.createdAt,
    last_seen_at: original.createdAt,
    push_token: id,
    push_environment: "production",
    notify_json: null,
  });
  const first = device("first");
  const second = device("second");
  const sent = vi.fn(async (value: { token: string; payload: string }) => ({
    status: value.token === "first" ? 429 : 200,
  }));
  const reactor = makeMobilePushReactor({
    serverId: () => "fixture",
    readShell: async () => ({
      ...fixtures.methods.getThreadShells.response,
      threads: [thread()],
    }),
    store: {
      active: () => true,
      devices: () => [first, second].values(),
      clearPush: () => Effect.void,
    },
    client: () => ({ client: { send: sent, close() {} }, baseBundleId: first.bundle_id }),
  });
  try {
    reactor.enabled(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(sent).not.toHaveBeenCalled();
    const peer = { device: second, send() {}, onClose: vi.fn() };
    for (let index = 0; index < 12; index++) {
      reactor.presence(peer, true, original.id);
      reactor.presence(peer, true, null);
    }
    reactor.presence(peer, true, original.id);
    expect(peer.onClose).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(16_000);
    approvalIds = ["old-approval", "new-approval"];
    const activity = Schema.decodeUnknownSync(OrchestrationEvent)({
      type: "thread.activity-appended",
      sequence: 12,
      eventId: "event",
      aggregateKind: "thread",
      aggregateId: original.id,
      occurredAt: original.createdAt,
      commandId: null,
      causationEventId: null,
      correlationId: null,
      metadata: {},
      payload: {
        threadId: original.id,
        activity: {
          id: "approval",
          turnId: null,
          createdAt: original.createdAt,
          tone: "approval",
          kind: "approval.requested",
          summary: "Approval",
          payload: { requestId: "new-approval" },
        },
      },
    });
    reactor.event(activity);
    await vi.advanceTimersByTimeAsync(250);
    expect(sent.mock.calls.map(([input]) => input.token)).toEqual(["first", "second"]);
    for (const [input] of sent.mock.calls) {
      expect(JSON.parse(input.payload).f5.requestId).toBe("new-approval");
      expect(input.payload).not.toContain(original.title);
    }
    approvalIds = [];
    await vi.advanceTimersByTimeAsync(1000);
    expect(sent).toHaveBeenCalledTimes(2);
  } finally {
    reactor.enabled(false);
  }
});
