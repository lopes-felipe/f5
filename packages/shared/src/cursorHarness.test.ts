import { describe, expect, it } from "vitest";

import {
  CURSOR_SDK_VERSION,
  cursorAcpAutoReviewSupported,
  cursorRuntimeModes,
  cursorSdkFeatureCertified,
  cursorSdkHarnessAvailability,
  type CursorSdkGateRow,
} from "./cursorHarness";
import { providerRuntimeCapabilities } from "./providerRuntimeCapabilities";
import { runtimeModeCapabilities } from "./runtimeMode";

const mac = { platform: "darwin", arch: "arm64" };
const certified: ReadonlyArray<CursorSdkGateRow> = [
  {
    sdkVersion: CURSOR_SDK_VERSION,
    platform: "darwin-arm64",
    features: ["distribution", "runtime", "autoMode"],
    evidence: "test",
  },
];

describe("cursorHarness gates", () => {
  it("keeps the SDK harness unavailable until its rows pass", () => {
    expect(cursorSdkHarnessAvailability(mac).available).toBe(false);
    expect(cursorSdkHarnessAvailability(mac, {}, certified)).toEqual({ available: true });
    expect(cursorSdkHarnessAvailability(mac, { isolatedProfile: true }, certified).available).toBe(
      false,
    );
    expect(
      cursorSdkHarnessAvailability({ platform: "win32", arch: "arm64" }, {}, certified),
    ).toMatchObject({
      available: false,
    });
  });

  it("matches rows only for the pinned SDK version and platform", () => {
    expect(cursorSdkFeatureCertified("runtime", mac, certified)).toBe(true);
    expect(
      cursorSdkFeatureCertified("runtime", { platform: "linux", arch: "x64" }, certified),
    ).toBe(false);
    expect(
      cursorSdkFeatureCertified("runtime", mac, [{ ...certified[0]!, sdkVersion: "0.0.1" }]),
    ).toBe(false);
  });

  it("never offers Supervised or Auto-accept edits on the SDK harness", () => {
    const modes = cursorRuntimeModes("sdk", { host: mac, sdkGates: certified });
    expect([...modes].toSorted()).toEqual(["auto", "full-access"]);
    expect([...cursorRuntimeModes("sdk", { host: mac })]).toEqual(["full-access"]);
    expect(
      cursorRuntimeModes("sdk", {
        host: { platform: "win32", arch: "x64" },
        sdkGates: certified,
      }).has("auto"),
    ).toBe(false);
  });

  it("offers Auto on ACP only from the certified CLI version", () => {
    const gates = {
      planReplyOutcome: undefined,
      autoReviewMinimumVersion: "2026.08.01",
      catalogWithoutSession: false,
    };
    expect(cursorAcpAutoReviewSupported("2026.07.09", gates)).toBe(false);
    expect(cursorAcpAutoReviewSupported("2026.08.02", gates)).toBe(true);
    expect(cursorAcpAutoReviewSupported("2026.08.02")).toBe(false);
    expect([...runtimeModeCapabilities("cursor")].toSorted()).toEqual([
      "approval-required",
      "full-access",
    ]);
  });

  it("claims no gated capability for the SDK variant", () => {
    const sdk = providerRuntimeCapabilities("cursor", null, "sdk");
    expect(sdk.turnSteering).toBe(false);
    expect(sdk.nativeCompaction).toBe(false);
    expect(sdk.conversationRollback).toBe(false);
    expect(providerRuntimeCapabilities("cursor", null, "acp").turnSteering).toBe(true);
  });
});
