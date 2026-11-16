import { afterEach, describe, expect, it, vi } from "vitest";
import * as certification from "@t3tools/shared/providerIntegrationCertification";
import { certifiedBuiltin, selectComputerBackend } from "./computerBackendSelection";

const base = {
  enabled: true,
  preference: "auto" as const,
  provider: "codex" as const,
  platform: "darwin",
  arch: "arm64",
  fullAccess: true,
  nativeStatus: { available: true as const },
  builtin: { available: true, version: "1.0" },
};
afterEach(() => {
  vi.restoreAllMocks();
});
const certify = () => vi.spyOn(certification, "isIntegrationCertified").mockReturnValue(true);

describe("computer backend selection", () => {
  it("never selects a built-in without a certified record", () => {
    expect(certifiedBuiltin("codex", "darwin", "arm64")).toBe(
      certification.isIntegrationCertified("codex-computer", "darwin", "arm64"),
    );
    expect(certifiedBuiltin("claude", "darwin", "arm64")).toBe(false);
    if (!certification.isIntegrationCertified("codex-computer", "darwin", "arm64"))
      expect(selectComputerBackend(base)).toMatchObject({
        selection: { kind: "native", fallbackFrom: { kind: "codex-builtin" } },
      });
  });

  it("selects the certified, installed built-in only in auto and Full access", () => {
    certify();
    expect(selectComputerBackend(base)).toEqual({
      selection: { kind: "codex-builtin" },
      status: { available: true },
    });
    expect(selectComputerBackend({ ...base, preference: "f5" })).toEqual({
      selection: { kind: "native" },
      status: { available: true },
    });
    expect(selectComputerBackend({ ...base, fullAccess: false })).toMatchObject({
      selection: { kind: "native", fallbackFrom: { reason: "needs-full-access" } },
    });
    expect(
      selectComputerBackend({
        ...base,
        builtin: { available: false, reason: "Set up Computer Use" },
      }),
    ).toMatchObject({
      selection: { kind: "native", fallbackFrom: { reason: "Set up Computer Use" } },
    });
  });

  it("keeps Windows Codex and every Claude built-in native", () => {
    certify();
    expect(selectComputerBackend({ ...base, platform: "win32" })).toMatchObject({
      selection: { kind: "native", fallbackFrom: { reason: "unsupported-platform" } },
    });
    expect(selectComputerBackend({ ...base, provider: "claude" })).toMatchObject({
      selection: { kind: "native", fallbackFrom: { kind: "claude-builtin" } },
    });
  });

  it("reports both blockers and policy off", () => {
    expect(
      selectComputerBackend({
        ...base,
        nativeStatus: { available: false, reason: "helper-missing" },
        builtin: { available: false, reason: "not installed" },
      }),
    ).toMatchObject({ status: { reason: "helper-missing" }, builtinReason: "not installed" });
    expect(selectComputerBackend({ ...base, enabled: false })).toEqual({
      status: { available: false, reason: "disabled" },
    });
  });
});
