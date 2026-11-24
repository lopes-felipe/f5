import { ProfileId, type ProfileSummary } from "@t3tools/contracts";
import { Schema } from "effect";
import { expect, it } from "vitest";

import {
  GUEST_PROFILE_NAME,
  guestActiveProfile,
  guestProfileSnapshot,
  LINUX_VM_GUEST_ENVIRONMENT,
  resolveGuestProfileIdentity,
} from "./guestProfileIdentity.ts";

const hostId = Schema.decodeUnknownSync(ProfileId)("3f4e411d2db24ee2929521c467030696");

it("reads the served profile only inside a Linux VM guest, and refuses a guest without one", () => {
  expect(resolveGuestProfileIdentity({})).toEqual({ ok: true, profileId: undefined });
  expect(resolveGuestProfileIdentity({ desktopProfileId: hostId })).toEqual({
    ok: true,
    profileId: undefined,
  });
  expect(
    resolveGuestProfileIdentity({
      executionEnvironment: LINUX_VM_GUEST_ENVIRONMENT,
      desktopProfileId: hostId,
    }),
  ).toEqual({ ok: true, profileId: hostId });
  // Only the exact environment the launcher sets makes a guest; a near miss stays a host.
  for (const executionEnvironment of ["linux-vm", "linux-vm-guest-x", "LINUX-VM-GUEST", ""])
    expect(resolveGuestProfileIdentity({ executionEnvironment, desktopProfileId: hostId })).toEqual(
      { ok: true, profileId: undefined },
    );
  for (const desktopProfileId of [undefined, "", "../x", hostId.toUpperCase(), `${hostId}0`])
    expect(
      resolveGuestProfileIdentity({
        executionEnvironment: LINUX_VM_GUEST_ENVIRONMENT,
        desktopProfileId,
      }),
    ).toMatchObject({ ok: false, message: expect.stringMatching(/without the profile/) });
});

const summary = (id: string, isActive: boolean): ProfileSummary =>
  ({
    id,
    slug: isActive ? "default" : "other",
    name: isActive ? "Default" : "Other",
    port: 3773,
    isDefault: isActive,
    status: "ready",
    createdAt: "2026-11-24T00:00:00.000Z",
    stateDir: "/var/lib/f5/state",
    isActive,
    providerAccounts: [],
  }) as unknown as ProfileSummary;

it("reports only its active profile, as the host's VM profile on the forwarded port", () => {
  const active = {
    ...summary("a".repeat(32), true),
    invalidDirectories: [{ directory: "/work/gone", reason: "Missing." }],
    sharedRepositories: [{ workspaceRoot: "/work/repo", otherProfiles: ["Other"] }],
  };
  const snapshot = guestProfileSnapshot(
    {
      profiles: [active, summary("b".repeat(32), false)],
      diagnostic: { code: "invalid", message: "Unreadable.", path: "/var/lib/f5/x" },
    } as unknown as Parameters<typeof guestProfileSnapshot>[0],
    hostId,
    64969,
  );
  const { sharedRepositories: _guestOnly, ...kept } = active;
  // The guest registry's other records, cross-profile warnings and diagnostic stay inside.
  expect(snapshot).toEqual({
    profiles: [
      {
        ...kept,
        id: hostId,
        slug: "linux-vm",
        name: GUEST_PROFILE_NAME,
        isDefault: false,
        executionEnvironment: "linux-vm",
        port: 64969,
      },
    ],
  });
  expect(guestProfileSnapshot({ profiles: [] }, hostId, 64969)).toEqual({ profiles: [] });
  // A listener on an OS-assigned port reports 0, which the welcome schema rejects.
  expect(guestActiveProfile(summary("a".repeat(32), true), hostId, 0).port).toBe(3773);
});
