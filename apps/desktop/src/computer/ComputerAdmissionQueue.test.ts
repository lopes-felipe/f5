import { afterEach, describe, expect, it, vi } from "vitest";
import type { ComputerLeaseHolder, ComputerLeaseScope } from "@t3tools/contracts";
import { ComputerControlError } from "@t3tools/shared/computerControl";
import { ComputerAdmissionQueue } from "./ComputerAdmissionQueue";
import { ComputerLeaseAuthority } from "./ComputerLeaseAuthority";

const holder = (
  threadId: string,
  scope: ComputerLeaseScope = { kind: "foreground" },
  profileId = "p",
): ComputerLeaseHolder => ({
  profileId,
  threadId,
  scope,
  backend: "native",
  threadTitle: threadId,
  sessionGeneration: "s",
  turnId: "turn",
  executionGeneration: 1,
  grantVersion: 1,
  grants: [],
  policyRevision: 0,
});
const queues: ComputerAdmissionQueue[] = [];
afterEach(() => {
  for (const queue of queues.splice(0)) queue.close();
  vi.useRealTimers();
});
function fixture() {
  let now = 0;
  const lease = new ComputerLeaseAuthority(() => now);
  const state = vi.fn();
  const sweep = vi.fn();
  const queue = new ComputerAdmissionQueue({
    conflicts: (a, b) => lease.scopesConflict(a, b),
    renewal: (input) => lease.renewal(input),
    sweep,
    state,
    now: () => now,
  });
  lease.subscribe(() => queue.changed());
  queues.push(queue);
  const acquire = (input: ComputerLeaseHolder, waitMs = 20_000) =>
    queue.admit({
      kind: "lease",
      holder: input,
      profileId: input.profileId,
      requestId: input.threadId,
      waitMs,
      admit: () => lease.acquire(input),
    });
  return {
    lease,
    queue,
    acquire,
    state,
    sweep,
    advance: (ms: number) => {
      now += ms;
      queue.changed();
    },
  };
}
describe("computer admission FIFO", () => {
  it("does not let sustained arrivals jump an earlier conflicting profile or takeover", async () => {
    const h = fixture();
    const active = h.lease.acquire(holder("active"));
    const first = h.acquire(holder("first", { kind: "app", appId: "notes" }, "other"));
    const foreground = h.acquire(holder("foreground"));
    const later = h.acquire(holder("later", { kind: "app", appId: "mail" }));
    h.lease.release(active);
    const granted = await first;
    expect(h.lease.holders()).toEqual([granted]);
    h.lease.release(granted);
    const second = await foreground;
    expect(h.lease.holders()).toEqual([second]);
    h.lease.release(second);
    expect((await later).threadId).toBe("later");
  });
  it("allows independent apps and same-turn renewals while conflicting requests wait", async () => {
    const h = fixture();
    const app = holder("active", { kind: "app", appId: "notes" });
    const active = await h.acquire(app);
    const first = h.acquire(holder("first", app.scope));
    expect(await h.acquire(app)).toBe(active);
    expect((await h.acquire(holder("mail", { kind: "app", appId: "mail" }))).threadId).toBe("mail");
    h.lease.release(active);
    expect((await first).threadId).toBe("first");
  });
  it("shares ordering with takeover reservations and handles reentrant lease notifications once", async () => {
    const h = fixture();
    const active = h.lease.acquire(holder("active"));
    const takeover = holder("takeover", { kind: "takeover", appId: "notes", approvalReceipt: "x" });
    const reserve = vi.fn(() => h.lease.reserveTakeover(takeover));
    const first = h.queue.admit({
      kind: "takeover",
      holder: takeover,
      profileId: "p",
      requestId: "reservation",
      waitMs: 20_000,
      admit: reserve,
    });
    const second = h.acquire(holder("later"));
    h.lease.release(active);
    const reservation = await first;
    expect(reserve).toHaveBeenCalledTimes(2); // initial Busy, then one successful reservation
    expect(h.lease.holders()).toEqual([]);
    h.lease.cancelTakeover(reservation);
    expect((await second).threadId).toBe("later");
  });
  it("rejects user activity immediately and returns the last waitable error on deadline", async () => {
    const h = fixture();
    const input = holder("wait");
    await expect(
      h.queue.admit({
        kind: "lease",
        holder: input,
        profileId: "p",
        requestId: "user",
        waitMs: 20_000,
        admit: () => {
          throw new ComputerControlError({ _tag: "TargetBlocked", kind: "user-active" });
        },
      }),
    ).rejects.toMatchObject({ error: { kind: "user-active" } });
    h.lease.acquire(holder("active"));
    const pending = h.acquire(input, 1000);
    const rejected = expect(pending).rejects.toMatchObject({ error: { _tag: "Busy" } });
    h.advance(1000);
    await rejected;
    expect(h.queue.holders()).toEqual([]);
    expect(h.state).toHaveBeenLastCalledWith(input, false);
  });
  it("bounds waiters per profile and desktop and cancels without admission", async () => {
    const h = fixture();
    h.lease.acquire(holder("active"));
    const pending = Array.from({ length: 64 }, (_, i) =>
      h.acquire(holder(String(i), { kind: "foreground" }, "p" + Math.floor(i / 16))),
    );
    const results = Promise.allSettled(pending);
    await expect(h.acquire(holder("overflow", { kind: "foreground" }, "p0"))).rejects.toMatchObject(
      { error: { _tag: "Busy" } },
    );
    await expect(
      h.acquire(holder("global", { kind: "foreground" }, "extra")),
    ).rejects.toMatchObject({ error: { _tag: "Busy" } });
    h.queue.cancel(() => true);
    expect((await results).every((result) => result.status === "rejected")).toBe(true);
    expect(h.lease.holders().map((input) => input.threadId)).toEqual(["active"]);
  });
});
