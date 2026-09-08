import { describe, expect, it } from "vitest";
import { Schema } from "effect";
import { ProfileId } from "@t3tools/contracts";
import {
  profilePartition,
  profilePreviewPartition,
  profileWindowArguments,
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
  it("passes immutable per-window identity and backend URL in renderer arguments", () => {
    expect(profileWindowArguments(profile.id, "ws://127.0.0.1:4567/?token=owned")).toEqual([
      `--f5-profile-id=${profile.id}`,
      "--f5-ws-url=ws://127.0.0.1:4567/?token=owned",
    ]);
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
