import { describe, expect, it, vi } from "vitest";
import type { ComputerLeaseHolder, ComputerLeaseScope } from "@t3tools/contracts";
import { ComputerLeaseAuthority } from "./ComputerLeaseAuthority";
const holder: ComputerLeaseHolder = {
  profileId: "p",
  threadId: "t",
  sessionGeneration: "s",
  turnId: "turn",
  executionGeneration: 1,
  grantVersion: 1,
  grants: [],
  backend: "native",
  threadTitle: "Private title",
  scope: { kind: "foreground" },
  policyRevision: 0,
};
const on = (threadId: string, scope: ComputerLeaseScope): ComputerLeaseHolder => ({
  ...holder,
  threadId,
  threadTitle: threadId,
  scope,
});
const app = (appId: string): ComputerLeaseScope => ({ kind: "app", appId });
const takeover = (appId: string): ComputerLeaseScope => ({
  kind: "takeover",
  appId,
  approvalReceipt: "pending",
});
const busy = (run: () => unknown) =>
  expect(run).toThrow(
    expect.objectContaining({ error: expect.objectContaining({ _tag: "Busy" }) }),
  );
describe("machine computer lease", () => {
  it("competes across profiles and provider backends without exposing other profile titles", () => {
    const lease = new ComputerLeaseAuthority();
    lease.acquire(holder);
    try {
      lease.acquire({ ...holder, profileId: "other", backend: "claude-builtin" });
      throw new Error("expected Busy");
    } catch (error) {
      expect(error).toMatchObject({ error: { _tag: "Busy", holder: "other-profile" } });
      expect(JSON.stringify(error)).not.toContain("Private title");
      expect((error as { error: object }).error).not.toHaveProperty("holderThreadId");
    }
  });
  it("names the holding thread to another thread in the same profile", () => {
    const lease = new ComputerLeaseAuthority();
    lease.acquire(holder);
    try {
      lease.acquire({ ...holder, threadId: "other-thread" });
      throw new Error("expected Busy");
    } catch (error) {
      expect(error).toMatchObject({
        error: {
          _tag: "Busy",
          holder: "same-profile",
          resource: "computer",
          holderThreadId: holder.threadId,
          threadTitle: holder.threadTitle,
        },
      });
    }
  });
  it("ignores late releases from older turns", () => {
    const lease = new ComputerLeaseAuthority();
    const first = lease.acquire(holder);
    lease.release(first);
    const second = lease.acquire({ ...holder, turnId: "new" });
    lease.release(first);
    expect(lease.holders()).toEqual([second]);
    expect(second.executionGeneration).toBeGreaterThan(first.executionGeneration);
  });
  it("releases after mutation idle per holder and fans out", () => {
    let now = 1;
    const lease = new ComputerLeaseAuthority(() => now);
    const listener = vi.fn();
    lease.subscribe(listener);
    const first = lease.acquire(on("a", app("calc")));
    now += 30_000;
    const second = lease.acquire(on("b", app("notes")));
    now += 30_000;
    lease.sweep();
    expect(lease.holders()).toEqual([second]);
    expect(listener).toHaveBeenLastCalledWith([second]);
    expect(lease.acquire(on("a", app("calc"))).executionGeneration).toBeGreaterThan(
      first.executionGeneration,
    );
  });
  it("lets two threads hold two apps and refuses a second agent in the same app", () => {
    const lease = new ComputerLeaseAuthority();
    const a = lease.acquire(on("a", app("calc")));
    const b = lease.acquire(on("b", app("notes")));
    expect(lease.holders()).toEqual([a, b]);
    busy(() => lease.acquire(on("c", app("calc"))));
  });
  it("keeps foreground exclusive with every other lease, both ways", () => {
    const lease = new ComputerLeaseAuthority();
    const a = lease.acquire(on("a", app("calc")));
    busy(() => lease.acquire(on("f", { kind: "foreground" })));
    lease.release(a);
    lease.acquire(on("f", { kind: "foreground" }));
    busy(() => lease.acquire(on("a", app("calc"))));
    busy(() => lease.reserveTakeover(on("a", takeover("calc"))));
  });
  it("conflicts takeovers with app leases of their app and with other takeovers", () => {
    const lease = new ComputerLeaseAuthority();
    lease.acquire(on("a", app("calc")));
    busy(() => lease.reserveTakeover(on("b", takeover("calc"))));
    const reservation = lease.reserveTakeover(on("b", takeover("notes")));
    // A pending takeover blocks other takeovers, foreground and the same app.
    busy(() => lease.reserveTakeover(on("c", takeover("mail"))));
    busy(() => lease.acquire(on("c", { kind: "foreground" })));
    busy(() => lease.acquire(on("c", app("notes"))));
    const armed = lease.armTakeover(reservation, "receipt");
    expect(armed.scope).toEqual({ kind: "takeover", appId: "notes", approvalReceipt: "receipt" });
    expect(lease.takeover()).toEqual(armed);
    expect(lease.pendingTakeover()).toBeNull();
    // Background leases elsewhere stay held while the takeover is armed.
    expect(lease.holders().map((entry) => entry.threadId)).toEqual(["a", "b"]);
    busy(() => lease.acquire(on("c", app("notes"))));
    expect(lease.acquire(on("c", app("mail"))).threadId).toBe("c");
  });
  it("replaces a thread's own lease on takeover and on a same-turn scope change", () => {
    const lease = new ComputerLeaseAuthority();
    const first = lease.acquire(on("a", app("calc")));
    expect(lease.acquire(on("a", app("calc")))).toBe(first);
    const moved = lease.acquire(on("a", app("notes")));
    expect(lease.holders()).toEqual([moved]);
    busy(() => lease.acquire({ ...on("a", app("mail")), turnId: "other-turn" }));
    const armed = lease.armTakeover(lease.reserveTakeover(on("a", takeover("notes"))), "r");
    expect(lease.holders()).toEqual([armed]);
  });
  it("refuses ordinary acquisition of a takeover scope and stale reservations", () => {
    const lease = new ComputerLeaseAuthority();
    expect(() => lease.acquire(on("a", takeover("calc")))).toThrow();
    const reservation = lease.reserveTakeover(on("a", takeover("calc")));
    lease.cancelTakeover(reservation);
    expect(() => lease.armTakeover(reservation, "late")).toThrow();
    expect(lease.holders()).toEqual([]);
  });
  it("reports Chrome conflicts for foreground, takeover and the Chrome app only", () => {
    const lease = new ComputerLeaseAuthority();
    lease.acquire(on("a", app("calc")));
    expect(lease.chromeConflict("p")).toBeNull();
    const chrome = lease.acquire(on("b", app("com.google.Chrome")));
    expect(lease.chromeConflict("p")).toEqual(chrome);
    lease.release(chrome);
    lease.reserveTakeover(on("c", takeover("notes")));
    expect(lease.chromeConflict("p")?.threadId).toBe("c");
  });
});
