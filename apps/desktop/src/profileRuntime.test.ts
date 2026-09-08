import { describe, expect, it, vi } from "vitest";
import { Schema } from "effect";
import { ProfileId } from "@t3tools/contracts";
import {
  profilePartition,
  profilePreviewPartition,
  profileWindowArguments,
  singleProfileOpen,
  ensureProfileConnection,
} from "./profileRuntime";
import { buildDesktopBackendEnv } from "./backendEnv";

describe("profile window isolation", () => {
  const profile = { id: Schema.decodeUnknownSync(ProfileId)("a".repeat(32)), isDefault: false };
  it("preserves Default storage and separates non-default browsing and previews", () => {
    expect(profilePartition({ ...profile, isDefault: true })).toBeUndefined();
    expect(profilePreviewPartition({ ...profile, isDefault: true })).toBe("persist:f5-preview");
    expect(profilePartition(profile)).toBe(`persist:f5-profile-${profile.id}`);
    expect(profilePreviewPartition(profile)).not.toBe(profilePartition(profile));
  });
  it("passes only immutable identity, never credentials, in renderer arguments", () => {
    expect(profileWindowArguments(profile.id)).toEqual([`--f5-profile-id=${profile.id}`]);
    expect(
      buildDesktopBackendEnv(
        {},
        {
          backendPort: 4567,
          stateDir: "state",
          stateDirSource: "explicit-state",
          authToken: "owned",
          profileSlug: "work",
        },
      ).F5_PROFILE,
    ).toBe("work");
  });
});

it("coalesces concurrent opens and permits reopening after completion", async () => {
  let calls = 0;
  let release!: () => void;
  const open = singleProfileOpen(async () => {
    calls++;
    await new Promise<void>((r) => {
      release = r;
    });
    return true;
  });
  const first = open("work");
  const second = open("work");
  expect(first).toBe(second);
  await Promise.resolve();
  expect(calls).toBe(1);
  release();
  await first;
  const reopened = open("work");
  await Promise.resolve();
  expect(calls).toBe(2);
  release();
  await reopened;
});

it("reopens a stopped profile without stranding either retained window", async () => {
  const runtime = { backendPort: 0, backendAuthToken: "", backendWsUrl: "" };
  const reserve = vi.fn(async () => 4555);
  const mint = vi.fn(() => "owned-token");
  const url = (port: number, token: string) => `ws://127.0.0.1:${port}/?token=${token}`;
  await ensureProfileConnection(runtime, reserve, mint, url);
  const retainedWindows = ["thread-a", "thread-b"].map((thread) => ({
    thread,
    preloadUrl: runtime.backendWsUrl,
  }));
  // Stopping the process retains runtime identity; reopening must reuse both windows' immutable URLs.
  await ensureProfileConnection(runtime, reserve, mint, url);
  expect(retainedWindows.every((window) => window.preloadUrl === runtime.backendWsUrl)).toBe(true);
  expect(retainedWindows.map((window) => window.thread)).toEqual(["thread-a", "thread-b"]);
  expect(reserve).toHaveBeenCalledTimes(1);
  expect(mint).toHaveBeenCalledTimes(1);
});
