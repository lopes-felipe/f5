import { afterEach, describe, expect, it, vi } from "vitest";
import type { CodeSignatureResult } from "@t3tools/shared/codeSignature";
import * as certification from "@t3tools/shared/providerIntegrationCertification";
import {
  computerBackgroundGate,
  computerCertificationStatus,
  COMPUTER_CONTROL_CERTIFIED,
  verifyCodexChromeAdoption,
} from "./certification";

afterEach(() => vi.restoreAllMocks());

describe("Codex Chrome adoption", () => {
  it("verifies nothing and adopts nothing while Codex Chrome is uncertified", async () => {
    vi.spyOn(certification, "certifiedIntegrationRecord").mockReturnValue(undefined);
    let verified = 0;
    const verify = async () => {
      verified += 1;
      return { ok: true as const, teamId: "2DC432GLL2", identifier: "codex" };
    };
    await expect(verifyCodexChromeAdoption(4242, 4343, verify, "darwin", "arm64")).resolves.toBe(
      "Codex Chrome control isn't certified.",
    );
    expect(verified).toBe(0);
  });

  it("checks both running processes by PID under the record's team", async () => {
    const record = certification.PROVIDER_INTEGRATION_RECORDS["codex-chrome"][0]!;
    vi.spyOn(certification, "certifiedIntegrationRecord").mockReturnValue(record as never);
    const signed = (identifier: string) => ({
      ok: true as const,
      teamId: record.identity.teamId,
      identifier,
    });
    const verify = vi.fn(
      async (pid: number): Promise<CodeSignatureResult> =>
        signed(pid === 4343 ? "node_repl" : "codex"),
    );
    await expect(verifyCodexChromeAdoption(4242, 4343, verify)).resolves.toBeUndefined();
    expect(verify.mock.calls).toEqual([
      [4343, { teamId: record.identity.teamId, identifier: "node_repl" }],
      [4242, { teamId: record.identity.teamId }],
    ]);
    verify.mockImplementation(async (pid) => signed(pid === 4343 ? "node_repl" : "other"));
    await expect(verifyCodexChromeAdoption(4242, 4343, verify)).resolves.toBe(
      "F5's Codex isn't an OpenAI-signed build.",
    );
    verify.mockImplementation(async () => ({ ok: false as const, reason: "mismatch" as const }));
    await expect(verifyCodexChromeAdoption(4242, 4343, verify)).resolves.toBe(
      "The ChatGPT app's browser runtime signature could not be verified.",
    );
  });
});
describe("preview availability is not certification", () => {
  it("permits macOS 14+ packaged preview without a development bypass", () => {
    expect(COMPUTER_CONTROL_CERTIFIED).toEqual({ darwin: false, win32: false });
    expect(computerCertificationStatus("darwin", true, undefined, "23.0.0")).toEqual({
      available: true,
    });
    expect(computerCertificationStatus("darwin", true, undefined, "22.0.0")).toMatchObject({
      reason: "os-too-old",
    });
  });
  it("permits Windows 19041+ packaged preview without a development bypass", () => {
    expect(computerCertificationStatus("win32", true, undefined, "10.0.19041")).toEqual({
      available: true,
    });
    expect(computerCertificationStatus("win32", true, undefined, "10.0.26340")).toEqual({
      available: true,
    });
    expect(computerCertificationStatus("win32", true, undefined, "10.0.18363")).toMatchObject({
      reason: "os-too-old",
    });
  });
  it("keeps Linux unavailable", () => {
    expect(computerCertificationStatus("linux", false, "1", "6.0.0")).toMatchObject({
      reason: "unsupported-platform",
    });
  });
  it.each(["darwin", "win32"])("offers background preview on %s in packaged builds", (platform) => {
    expect(computerBackgroundGate(platform, true, undefined)).toEqual({ available: true });
    expect(computerBackgroundGate(platform, false, undefined)).toEqual({ available: true });
  });
  it("keeps background control unavailable on unsupported platforms", () => {
    expect(computerBackgroundGate("linux", false, "1")).toEqual({
      available: false,
      reason: "unsupported-platform",
    });
  });
});
