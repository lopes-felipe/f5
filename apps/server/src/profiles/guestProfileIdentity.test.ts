import { ProfileId, type ProfileSummary } from "@t3tools/contracts";
import { Schema } from "effect";
import { expect, it } from "vitest";

import {
  GUEST_PROFILE_NAME,
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
  const snapshot = guestProfileSnapshot(
    { profiles: [summary("a".repeat(32), true), summary("b".repeat(32), false)] },
    hostId,
    64969,
  );
  expect(snapshot.profiles).toEqual([
    {
      ...summary("a".repeat(32), true),
      id: hostId,
      slug: "linux-vm",
      name: GUEST_PROFILE_NAME,
      isDefault: false,
      executionEnvironment: "linux-vm",
      port: 64969,
    },
  ]);
  expect(guestProfileSnapshot({ profiles: [] }, hostId, 64969).profiles).toEqual([]);
  // An OS-assigned port (0) never replaces the record's valid one.
  expect(
    guestProfileSnapshot({ profiles: [summary("a".repeat(32), true)] }, hostId, 0).profiles[0]
      ?.port,
  ).toBe(3773);
});
