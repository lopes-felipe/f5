import { describe, expect, it, vi } from "vitest";
import { ChromeLeaseAuthority } from "./ChromeLeaseAuthority";
import type { ComputerLeaseHolder } from "@t3tools/contracts";
const holder = {
  profileId: "profile-a",
  threadId: "thread",
  sessionGeneration: "generation",
  provider: "claude" as const,
};
describe("Chrome device lease", () => {
  it("excludes other profiles and native input, and ignores old session releases", () => {
    const changed = vi.fn();
    const lease = new ChromeLeaseAuthority(changed);
    lease.acquire(holder, null);
    lease.acquire(holder, null);
    expect(changed).toHaveBeenCalledOnce();
    expect(() => lease.acquire({ ...holder, profileId: "profile-b" }, null)).toThrow();
    expect(() => lease.assertNativeAvailable("profile-b")).toThrow();
    lease.release({ ...holder, sessionGeneration: "retired" });
    expect(lease.current()).toEqual(holder);
    lease.releaseProfile("profile-b");
    expect(lease.current()).toEqual(holder);
    lease.releaseProfile("profile-a");
    expect(lease.current()).toBeNull();
    expect(() => lease.assertNativeAvailable("profile-b")).not.toThrow();
  });
  it("rolls back ownership when its emergency shortcut cannot be registered", () => {
    const changed = vi.fn((current) => {
      if (current) throw new Error("shortcut unavailable");
    });
    const lease = new ChromeLeaseAuthority(changed);
    expect(() => lease.acquire(holder, null)).toThrow("shortcut unavailable");
    expect(lease.current()).toBeNull();
    expect(changed).toHaveBeenLastCalledWith(null);
  });
  it("does not acquire while native control owns the machine", () => {
    const lease = new ChromeLeaseAuthority(vi.fn());
    expect(() => lease.acquire(holder, { profileId: "other" } as ComputerLeaseHolder)).toThrow();
    expect(lease.current()).toBeNull();
  });
  it("main's pause veto survives reacquire attempts until explicit resume", () => {
    const lease = new ChromeLeaseAuthority(vi.fn());
    lease.acquire(holder, null);
    lease.setPaused(holder, true);
    lease.acquire(holder, null);
    expect(() => lease.validate(holder)).toThrow();
    lease.setPaused({ ...holder, sessionGeneration: "old" }, false);
    expect(() => lease.validate(holder)).toThrow();
    lease.setPaused(holder, false);
    expect(() => lease.validate(holder)).not.toThrow();
    expect(() => lease.validate({ ...holder, sessionGeneration: "old" })).toThrow();
  });
});
