import type { ProfileSummary } from "@t3tools/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./nativeApi", () => ({ ensureNativeApi: () => ({}), readNativeApi: () => null }));
vi.mock("./wsNativeApi", () => ({ onProfilesUpdated: () => () => {} }));

const { clearProfilePatches, reconcileProfiles, recordProfilePatch, profileBrowserUrl } =
  await import("./profileState");

const makeProfile = (overrides: Partial<ProfileSummary> = {}): ProfileSummary =>
  ({
    id: "a".repeat(32),
    slug: "work",
    name: "Work",
    port: 3774,
    isDefault: false,
    status: "ready",
    createdAt: "2026-05-26T00:00:00.000Z",
    stateDir: "C:\\profiles\\work",
    isActive: false,
    providerAccounts: [],
    ...overrides,
  }) as ProfileSummary;

beforeEach(() => {
  clearProfilePatches();
});

describe("reconcileProfiles", () => {
  it("returns the snapshot untouched when nothing is pending", () => {
    const snapshot = [makeProfile()];
    expect(reconcileProfiles(snapshot)).toBe(snapshot);
  });

  it("keeps an accepted rename visible when the server replays a stale snapshot", () => {
    // The server caches readProfiles() for 2000ms, so a refresh issued right
    // after a successful update can return the pre-edit value.
    const profile = makeProfile({ name: "Work" });
    recordProfilePatch(profile.id, { name: "Renamed" });

    const reconciled = reconcileProfiles([makeProfile({ name: "Work" })]);

    expect(reconciled[0]!.name).toBe("Renamed");
  });

  it("clears the patch once the server echoes the value, then stops overriding", () => {
    const profile = makeProfile();
    recordProfilePatch(profile.id, { name: "Renamed" });

    expect(reconcileProfiles([makeProfile({ name: "Renamed" })])[0]!.name).toBe("Renamed");

    // A later, genuine server-side change must win now that the patch settled.
    expect(reconcileProfiles([makeProfile({ name: "Other" })])[0]!.name).toBe("Other");
  });

  it("drops a patch once its TTL expires", () => {
    const profile = makeProfile();
    const now = Date.now();
    recordProfilePatch(profile.id, { name: "Renamed" });

    expect(reconcileProfiles([makeProfile({ name: "Work" })], now + 20_000)[0]!.name).toBe("Work");
    // And it is gone for good.
    expect(reconcileProfiles([makeProfile({ name: "Work" })], now)[0]!.name).toBe("Work");
  });

  it("merges successive patches for the same profile", () => {
    const profile = makeProfile();
    recordProfilePatch(profile.id, { name: "Renamed" });
    recordProfilePatch(profile.id, { port: 3999 });

    const reconciled = reconcileProfiles([makeProfile()])[0]!;

    expect(reconciled.name).toBe("Renamed");
    expect(reconciled.port).toBe(3999);
  });

  it("only patches the profile it was recorded against", () => {
    const other = makeProfile({ id: "b".repeat(32) as ProfileSummary["id"], name: "Personal" });
    recordProfilePatch("a".repeat(32), { name: "Renamed" });

    const reconciled = reconcileProfiles([makeProfile(), other]);

    expect(reconciled[0]!.name).toBe("Renamed");
    expect(reconciled[1]!.name).toBe("Personal");
  });

  it("ignores an empty patch", () => {
    recordProfilePatch("a".repeat(32), {});
    const snapshot = [makeProfile()];
    expect(reconcileProfiles(snapshot)).toBe(snapshot);
  });
});

describe("profileBrowserUrl", () => {
  it("builds a same-origin url on the profile's port", () => {
    expect(profileBrowserUrl({ port: 3774 }, { protocol: "http:", hostname: "localhost" })).toBe(
      "http://localhost:3774/",
    );
  });

  it("brackets a bare IPv6 host", () => {
    expect(profileBrowserUrl({ port: 3774 }, { protocol: "http:", hostname: "::1" })).toBe(
      "http://[::1]:3774/",
    );
  });

  it("leaves an already-bracketed IPv6 host alone", () => {
    expect(profileBrowserUrl({ port: 3774 }, { protocol: "https:", hostname: "[::1]" })).toBe(
      "https://[::1]:3774/",
    );
  });
});
