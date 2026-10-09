import { describe, expect, it, vi } from "vitest";
import type { ComputerLeaseHolder } from "@t3tools/contracts";
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
};
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
    }
  });
  it("ignores late releases from older turns", () => {
    const lease = new ComputerLeaseAuthority();
    const first = lease.acquire(holder);
    lease.release(first);
    const second = lease.acquire({ ...holder, turnId: "new" });
    lease.release(first);
    expect(lease.current()).toEqual(second);
    expect(second.executionGeneration).toBeGreaterThan(first.executionGeneration);
  });
  it("releases after mutation idle and fans out", () => {
    let now = 1;
    const lease = new ComputerLeaseAuthority(() => now);
    const listener = vi.fn();
    lease.subscribe(listener);
    const first = lease.acquire(holder);
    now += 60_000;
    lease.sweep();
    expect(lease.current()).toBeNull();
    expect(listener).toHaveBeenCalledWith(null);
    expect(lease.acquire(holder).executionGeneration).toBeGreaterThan(first.executionGeneration);
  });
});
