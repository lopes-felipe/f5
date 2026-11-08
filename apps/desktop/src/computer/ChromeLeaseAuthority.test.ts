import { describe, expect, it, vi } from "vitest";
import { ComputerControlError } from "@t3tools/shared/computerControl";
import {
  CHROME_OWN_CALL_RUNNING_MESSAGE,
  CHROME_OWN_CODEX_MESSAGE,
  CHROME_OWN_STOPPING_MESSAGE,
  CHROME_RECOVERY_MESSAGE,
  ChromeLeaseAuthority,
  isChromeSelfWait,
} from "./ChromeLeaseAuthority";
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

describe("native control for the Chrome holder's own thread", () => {
  const refusal = (run: () => void) => {
    try {
      run();
    } catch (error) {
      return (error as { error: unknown }).error;
    }
    return undefined;
  };
  const self = { threadId: "thread" };

  it("lets a Claude holder's own thread take native control while its calls are idle", () => {
    let idle = true;
    const lease = new ChromeLeaseAuthority(vi.fn(), undefined, { callsIdle: () => idle });
    lease.acquire(holder, null);
    expect(
      refusal(() => lease.assertNativeAvailable("profile-a", undefined, self)),
    ).toBeUndefined();
    expect(
      refusal(() =>
        lease.assertNativeAvailable("profile-a", { kind: "app", appId: "com.google.Chrome" }, self),
      ),
    ).toBeUndefined();
    // Its own running call refuses with a message that never reads as another thread.
    idle = false;
    expect(refusal(() => lease.assertNativeAvailable("profile-a", undefined, self))).toEqual({
      _tag: "Execution",
      message: CHROME_OWN_CALL_RUNNING_MESSAGE,
    });
  });

  it("treats an unreported call state as running", () => {
    const lease = new ChromeLeaseAuthority(vi.fn());
    lease.acquire(holder, null);
    expect(refusal(() => lease.assertNativeAvailable("profile-a", undefined, self))).toEqual({
      _tag: "Execution",
      message: CHROME_OWN_CALL_RUNNING_MESSAGE,
    });
  });

  it("keeps other threads, other profiles and Codex holders exclusive", () => {
    const lease = new ChromeLeaseAuthority(vi.fn(), undefined, { callsIdle: () => true });
    lease.acquire(holder, null);
    expect(
      refusal(() => lease.assertNativeAvailable("profile-a", undefined, { threadId: "other" })),
    ).toEqual({
      _tag: "Busy",
      resource: "chrome",
      holder: "same-profile",
      holderThreadId: "thread",
    });
    expect(refusal(() => lease.assertNativeAvailable("profile-b", undefined, self))).toEqual({
      _tag: "Busy",
      resource: "chrome",
      holder: "other-profile",
    });
    // No requester (Sky's builtin path) is never exempt.
    expect(refusal(() => lease.assertNativeAvailable("profile-a"))).toMatchObject({
      _tag: "Busy",
    });
    // A same-thread Codex holder stays exclusive, but never reads as another thread.
    const codex = new ChromeLeaseAuthority(vi.fn(), undefined, { callsIdle: () => true });
    codex.acquire({ ...holder, provider: "codex" }, null);
    expect(refusal(() => codex.assertNativeAvailable("profile-a", undefined, self))).toEqual({
      _tag: "Execution",
      message: CHROME_OWN_CODEX_MESSAGE,
    });
  });

  it("marks only refusals that clear by themselves as waitable", () => {
    const execution = (message: string) => new ComputerControlError({ _tag: "Execution", message });
    expect(isChromeSelfWait(execution(CHROME_OWN_CALL_RUNNING_MESSAGE))).toBe(true);
    expect(isChromeSelfWait(execution(CHROME_OWN_STOPPING_MESSAGE))).toBe(true);
    expect(isChromeSelfWait(execution(CHROME_RECOVERY_MESSAGE))).toBe(false);
    // Codex's session doesn't end on its own while its thread works.
    expect(isChromeSelfWait(execution(CHROME_OWN_CODEX_MESSAGE))).toBe(false);
    expect(
      isChromeSelfWait(new ComputerControlError({ _tag: "Busy", holder: "same-profile" })),
    ).toBe(false);
  });

  it("never exempts a draining lease or one that needs recovery", () => {
    let alive = true;
    let recovery = false;
    const lease = new ChromeLeaseAuthority(
      vi.fn(),
      { alive: () => alive, stop: vi.fn(() => []), recoveryRequired: () => recovery },
      { callsIdle: () => true },
    );
    lease.acquire(holder, null);
    lease.release(holder);
    // Its own stopping lease says so instead of naming itself as another thread.
    expect(refusal(() => lease.assertNativeAvailable("profile-a", undefined, self))).toEqual({
      _tag: "Execution",
      message: CHROME_OWN_STOPPING_MESSAGE,
    });
    expect(
      refusal(() => lease.assertNativeAvailable("profile-a", undefined, { threadId: "other" })),
    ).toMatchObject({ _tag: "Busy", holderThreadId: "thread" });
    alive = false;
    lease.processExited();
    recovery = true;
    expect(refusal(() => lease.assertNativeAvailable("profile-a", undefined, self))).toEqual({
      _tag: "Execution",
      message: CHROME_RECOVERY_MESSAGE,
    });
  });

  it("logs lease events with thread ids, rate-limiting repeated refusals and grants", () => {
    const log = vi.fn();
    let idle = true;
    let now = 0;
    const lease = new ChromeLeaseAuthority(vi.fn(), undefined, {
      callsIdle: () => idle,
      log,
      now: () => now,
    });
    lease.acquire(holder, null);
    lease.assertNativeAvailable("profile-a", undefined, self);
    lease.assertNativeAvailable("profile-a", undefined, self);
    idle = false;
    const other = { threadId: "other" };
    // Two waiters alternating (as the 250 ms admission retry does) still log each line once.
    for (let attempt = 0; attempt < 5; attempt++) {
      expect(() => lease.assertNativeAvailable("profile-a", undefined, self)).toThrow();
      expect(() => lease.assertNativeAvailable("profile-a", undefined, other)).toThrow();
    }
    expect(() => lease.acquire({ ...holder, threadId: "other" }, null)).toThrow();
    lease.release(holder);
    const lines = log.mock.calls.map(([line]) => line as string);
    expect(lines.every((line) => line.startsWith("chrome lease: "))).toBe(true);
    expect(lines).toEqual([
      expect.stringMatching(/^chrome lease: acquired .*thread=thread provider=claude/),
      expect.stringMatching(/native allowed for the Chrome holder's own thread .*thread=thread/),
      expect.stringMatching(/native refused: own Chrome call running .*thread=thread/),
      expect.stringMatching(
        /native refused for profile=profile-a thread=other: held by .*thread=thread/,
      ),
      expect.stringMatching(/acquire refused .*thread=other.*held by .*thread=thread/),
      expect.stringMatching(/release requested, reason=release .*thread=thread/),
      expect.stringMatching(/released .*thread=thread/),
    ]);
    // After the window, a repeated refusal is logged again.
    log.mockClear();
    lease.acquire(holder, null);
    expect(() => lease.assertNativeAvailable("profile-a", undefined, other)).toThrow();
    expect(log).toHaveBeenCalledTimes(1);
    now = 30_000;
    expect(() => lease.assertNativeAvailable("profile-a", undefined, other)).toThrow();
    expect(log).toHaveBeenCalledTimes(2);
  });
});
