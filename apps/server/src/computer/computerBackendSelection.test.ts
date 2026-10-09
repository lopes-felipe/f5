import { describe, expect, it } from "vitest";
import {
  selectComputerBackend,
  type BuiltinComputerCertification,
} from "./computerBackendSelection";
const certification: BuiltinComputerCertification = {
  provider: "claude",
  platform: "darwin",
  minVersion: "1",
  maxVersion: "2",
  manifestHash: "a".repeat(64),
  evidence: "record",
  consent: true,
  preExecutionVeto: true,
  stop: true,
  observation: true,
  f5Isolation: true,
  profileIsolation: true,
};
describe("computer backend selection", () => {
  it.each([
    { version: "0.9", manifestHash: certification.manifestHash },
    { version: "2.1", manifestHash: certification.manifestHash },
    { version: "1.5-beta", manifestHash: certification.manifestHash },
    { version: "1.5", manifestHash: "b".repeat(64) },
    {},
  ])("refuses version or manifest drift: %j", (observed) => {
    expect(
      selectComputerBackend({
        enabled: true,
        preference: "auto",
        provider: "claude",
        platform: "darwin",
        nativeStatus: { available: true },
        builtin: { available: true, certification, ...observed },
      }),
    ).toMatchObject({ selection: { kind: "native" } });
  });
  it("prefers certified built-in and never returns both catalogs", () => {
    expect(
      selectComputerBackend({
        enabled: true,
        preference: "auto",
        provider: "claude",
        platform: "darwin",
        nativeStatus: { available: true },
        builtin: {
          available: true,
          certification,
          version: "1.5",
          manifestHash: certification.manifestHash,
        },
      }),
    ).toMatchObject({ selection: { kind: "claude-builtin" } });
  });
  it.each([
    "consent",
    "preExecutionVeto",
    "stop",
    "observation",
    "f5Isolation",
    "profileIsolation",
  ] as const)("falls back when %s fails", (key) => {
    expect(
      selectComputerBackend({
        enabled: true,
        preference: "auto",
        provider: "claude",
        platform: "darwin",
        nativeStatus: { available: true },
        builtin: {
          available: true,
          reason: key,
          certification: { ...certification, [key]: false },
        },
      }),
    ).toMatchObject({ selection: { kind: "native", fallbackFrom: { reason: key } } });
  });
  it("honors F5-only and keeps Windows Codex native", () => {
    for (const [provider, platform, preference] of [
      ["claude", "darwin", "f5"],
      ["codex", "win32", "auto"],
    ] as const) {
      expect(
        selectComputerBackend({
          enabled: true,
          preference,
          provider,
          platform,
          nativeStatus: { available: true },
          builtin: { available: true, certification },
        }),
      ).toMatchObject({ selection: { kind: "native" } });
    }
  });
  it("reports both blockers and policy off", () => {
    expect(
      selectComputerBackend({
        enabled: true,
        preference: "auto",
        provider: "claude",
        platform: "darwin",
        nativeStatus: { available: false, reason: "helper-missing" },
        builtin: { available: false, reason: "SDK consent" },
      }),
    ).toMatchObject({ status: { reason: "helper-missing" }, builtinReason: "SDK consent" });
    expect(
      selectComputerBackend({
        enabled: false,
        preference: "auto",
        provider: "claude",
        platform: "darwin",
        nativeStatus: { available: true },
        builtin: { available: true, certification },
      }),
    ).toEqual({ status: { available: false, reason: "disabled" } });
  });
});
