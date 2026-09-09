import { ProviderInstanceId, type ProfileSummary } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  PROFILE_STATUS_STYLES,
  isProfileEditable,
  orderProfiles,
  previewProfileSlug,
  profileAccountPresentation,
  profileLaunchCommand,
  profileLocationLabel,
  profileStatusPresentation,
  profileWarnings,
  validateProfilePort,
} from "./profileStatus";

const makeProfile = (overrides: Partial<ProfileSummary> = {}): ProfileSummary =>
  ({
    id: "0".repeat(32),
    slug: "default",
    name: "Default",
    port: 3773,
    isDefault: true,
    status: "ready",
    createdAt: "2026-05-26T00:00:00.000Z",
    stateDir: "C:\\Users\\lopes\\.f5\\userdata",
    isActive: true,
    providerAccounts: [],
    ...overrides,
  }) as ProfileSummary;

describe("profile status styles", () => {
  it("covers every lifecycle status in the contract", () => {
    expect(Object.keys(PROFILE_STATUS_STYLES).sort()).toEqual([
      "provisioning",
      "ready",
      "removing",
    ]);
  });

  it("uses only design tokens, never literal palette classes", () => {
    // themePalette.ts rewrites the token custom properties at runtime, so a
    // hardcoded `bg-amber-400` would not respond to user themes.
    for (const style of Object.values(PROFILE_STATUS_STYLES)) {
      expect(style.dot).not.toMatch(/-(amber|red|green|blue|yellow|orange)-\d{3}/);
    }
  });

  it("marks non-ready profiles busy and explains why", () => {
    expect(profileStatusPresentation(makeProfile()).busy).toBe(false);
    expect(profileStatusPresentation(makeProfile()).detail).toBeNull();

    const provisioning = profileStatusPresentation(makeProfile({ status: "provisioning" }));
    expect(provisioning.busy).toBe(true);
    expect(provisioning.label).toBe("Setting up");
    expect(provisioning.detail).toContain("still being set up");

    expect(profileStatusPresentation(makeProfile({ status: "removing" })).badge).toBe("error");
  });

  it("only allows edits while ready", () => {
    expect(isProfileEditable(makeProfile())).toBe(true);
    expect(isProfileEditable(makeProfile({ status: "provisioning" }))).toBe(false);
    expect(isProfileEditable(makeProfile({ status: "removing" }))).toBe(false);
  });
});

describe("account presentation", () => {
  const account = (
    status: ProfileSummary["providerAccounts"][number]["status"],
    extra: { identity?: string; reason?: string } = {},
  ) =>
    ({
      driver: "codex",
      instanceId: ProviderInstanceId.make("codex"),
      displayName: "Codex",
      status,
      ...extra,
    }) as ProfileSummary["providerAccounts"][number];

  it("maps all four account statuses", () => {
    expect(profileAccountPresentation(account("authenticated")).label).toBe("Signed in");
    expect(profileAccountPresentation(account("unauthenticated")).label).toBe("Not signed in");
    expect(profileAccountPresentation(account("unknown")).label).toBe("Unknown");
    expect(profileAccountPresentation(account("unsupported-isolation")).label).toBe("Not isolated");
  });

  it("prefers identity over reason for the detail line", () => {
    const presentation = profileAccountPresentation(
      account("authenticated", { identity: "user@example.com", reason: "ignored" }),
    );
    expect(presentation.detail).toBe("user@example.com");
  });

  it("falls back to reason when there is no identity", () => {
    expect(profileAccountPresentation(account("unknown", { reason: "probe failed" })).detail).toBe(
      "probe failed",
    );
    expect(profileAccountPresentation(account("unknown")).detail).toBeNull();
  });

  it("offers no sign-in for drivers that cannot be isolated", () => {
    expect(profileAccountPresentation(account("unsupported-isolation")).canSignIn).toBe(false);
    expect(profileAccountPresentation(account("unauthenticated")).canSignIn).toBe(true);
  });
});

describe("profile warnings", () => {
  it("returns nothing when the profile is clean", () => {
    expect(profileWarnings(makeProfile())).toEqual([]);
  });

  it("flattens both warning arrays with stable unique keys", () => {
    const warnings = profileWarnings(
      makeProfile({
        invalidDirectories: [{ directory: "C:\\gone", reason: "Missing." }],
        sharedRepositories: [{ workspaceRoot: "C:\\repo", otherProfiles: ["Work", "Personal"] }],
      }),
    );
    expect(warnings).toHaveLength(2);
    expect(new Set(warnings.map((warning) => warning.key)).size).toBe(2);
    expect(warnings[0]!.detail).toContain("C:\\gone");
    expect(warnings[1]!.detail).toContain("Work, Personal");
  });
});

describe("port validation", () => {
  const profiles = [
    makeProfile({ id: "a".repeat(32) as ProfileSummary["id"], port: 3773 }),
    makeProfile({
      id: "b".repeat(32) as ProfileSummary["id"],
      port: 3774,
      name: "Work",
      isActive: false,
    }),
  ];
  const selfId = profiles[0]!.id;

  it("rejects non-numeric and out-of-range input", () => {
    expect(validateProfilePort("", profiles, selfId)).toBe("Port is required.");
    expect(validateProfilePort("abc", profiles, selfId)).toBe("Port must be a whole number.");
    expect(validateProfilePort("3773.5", profiles, selfId)).toBe("Port must be a whole number.");
    expect(validateProfilePort("0", profiles, selfId)).toBe("Port must be between 1 and 65535.");
    expect(validateProfilePort("65536", profiles, selfId)).toBe(
      "Port must be between 1 and 65535.",
    );
  });

  it("accepts the boundaries", () => {
    expect(validateProfilePort("1", profiles, selfId)).toBeNull();
    expect(validateProfilePort("65535", profiles, selfId)).toBeNull();
  });

  it("accepts the profile's own current port but rejects another profile's", () => {
    expect(validateProfilePort("3773", profiles, selfId)).toBeNull();
    expect(validateProfilePort("3774", profiles, selfId)).toBe(
      "Port 3774 is already used by Work.",
    );
  });
});

describe("slug preview", () => {
  it("matches the server derivation", () => {
    expect(previewProfileSlug("Work", [])).toBe("work");
    expect(previewProfileSlug("  My  Profile!  ", [])).toBe("my-profile");
    expect(previewProfileSlug("123", [])).toBe("profile-123");
  });

  it("truncates the stem to 26 characters", () => {
    expect(previewProfileSlug("a".repeat(40), [])).toBe("a".repeat(26));
  });

  it("appends a numeric suffix on collision", () => {
    expect(previewProfileSlug("Work", ["work"])).toBe("work-2");
    expect(previewProfileSlug("Work", ["work", "work-2"])).toBe("work-3");
  });
});

describe("presentation helpers", () => {
  it("formats the location and launch command", () => {
    const profile = makeProfile({ port: 3999, slug: "work" });
    expect(profileLocationLabel(profile)).toBe("localhost:3999");
    expect(profileLaunchCommand(profile)).toBe("t3 --profile work");
  });

  it("puts the active profile first without disturbing the rest", () => {
    const first = makeProfile({ id: "a".repeat(32) as ProfileSummary["id"], isActive: false });
    const second = makeProfile({ id: "b".repeat(32) as ProfileSummary["id"], isActive: true });
    const third = makeProfile({ id: "c".repeat(32) as ProfileSummary["id"], isActive: false });
    expect(orderProfiles([first, second, third]).map((profile) => profile.id)).toEqual([
      second.id,
      first.id,
      third.id,
    ]);
  });

  it("returns the input unchanged when nothing is active", () => {
    const profiles = [makeProfile({ isActive: false })];
    expect(orderProfiles(profiles)).toBe(profiles);
  });
});
