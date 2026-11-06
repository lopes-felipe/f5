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
  it("names a same-profile holder in its refusal and keeps other profiles anonymous", () => {
    const lease = new ChromeLeaseAuthority(vi.fn());
    lease.acquire(holder, null);
    const refusal = (run: () => void) => {
      try {
        run();
      } catch (error) {
        return (error as { error: unknown }).error;
      }
      throw new Error("expected Busy");
    };
    expect(refusal(() => lease.acquire({ ...holder, threadId: "other" }, null))).toEqual({
      _tag: "Busy",
      resource: "chrome",
      holder: "same-profile",
      holderThreadId: "thread",
    });
    expect(refusal(() => lease.assertNativeAvailable("profile-a"))).toEqual({
      _tag: "Busy",
      resource: "chrome",
      holder: "same-profile",
      holderThreadId: "thread",
    });
    expect(refusal(() => lease.acquire({ ...holder, profileId: "profile-b" }, null))).toEqual({
      _tag: "Busy",
      resource: "chrome",
      holder: "other-profile",
    });
    // Native control blocks a Chrome acquisition: named with its title in the same profile.
    const native = {
      profileId: "profile-b",
      threadId: "native-thread",
      threadTitle: "Native work",
    } as ComputerLeaseHolder;
    const fresh = new ChromeLeaseAuthority(vi.fn());
    expect(refusal(() => fresh.acquire({ ...holder, profileId: "profile-b" }, native))).toEqual({
      _tag: "Busy",
      resource: "computer",
      holder: "same-profile",
      holderThreadId: "native-thread",
      threadTitle: "Native work",
    });
    expect(refusal(() => fresh.acquire(holder, native))).toEqual({
      _tag: "Busy",
      resource: "computer",
      holder: "other-profile",
    });
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
  it("keeps a Codex lease after its leader exits until the whole group is gone", () => {
    let alive = true;
    const stop = vi.fn(() => []);
    const lease = new ChromeLeaseAuthority(vi.fn(), {
      alive: () => alive,
      stop,
      recoveryRequired: () => false,
    });
    const codex = { ...holder, provider: "codex" as const };
    lease.acquire(codex, null);
    // The proxy releases when `node_repl` exits; a worker it started is still running.
    lease.release(codex);
    expect(stop).toHaveBeenCalledWith(expect.any(Function), "release");
    expect(lease.current()).toEqual(codex);
    expect(() => lease.acquire({ ...holder, profileId: "profile-b" }, null)).toThrow();
    expect(() => lease.assertNativeAvailable("profile-b")).toThrow();
    lease.processExited();
    expect(lease.current()).toEqual(codex);
    alive = false;
    lease.processExited();
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
