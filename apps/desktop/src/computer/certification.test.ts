import { describe, expect, it } from "vitest";
import {
  computerBackgroundGate,
  computerCertificationStatus,
  COMPUTER_CONTROL_CERTIFIED,
  verifyCodexChromeAdoption,
} from "./certification";

describe("Codex Chrome adoption", () => {
  it("verifies nothing and adopts nothing while Codex Chrome is uncertified", async () => {
    let verified = 0;
    const verify = async () => {
      verified += 1;
      return { ok: true as const, teamId: "2DC432GLL2", identifier: "codex" };
    };
    await expect(
      verifyCodexChromeAdoption("/bin/codex", "/node_repl", verify, "darwin", "arm64"),
    ).resolves.toBe("Codex Chrome control isn't certified.");
    expect(verified).toBe(0);
  });
});
describe("preview availability is not certification", () => {
  it("permits macOS 14+ packaged opt-in preview without a development bypass", () => {
    expect(COMPUTER_CONTROL_CERTIFIED).toEqual({ darwin: false, win32: false });
    expect(computerCertificationStatus("darwin", true, undefined, "23.0.0")).toEqual({
      available: true,
    });
    expect(computerCertificationStatus("darwin", true, undefined, "22.0.0")).toMatchObject({
      reason: "os-too-old",
    });
  });
  it("keeps Windows packaged and Linux unavailable", () => {
    expect(computerCertificationStatus("win32", true, "1", "10.0.22631")).toMatchObject({
      reason: "not-certified",
    });
    expect(computerCertificationStatus("linux", false, "1", "6.0.0")).toMatchObject({
      reason: "unsupported-platform",
    });
  });
  it("opens background control on macOS by default, including packaged builds", () => {
    expect(computerBackgroundGate("darwin", true, undefined)).toEqual({ available: true });
    expect(computerBackgroundGate("darwin", false, undefined)).toEqual({ available: true });
    expect(computerBackgroundGate("win32", true, "1")).toEqual({
      available: false,
      reason: "unsupported-platform",
    });
  });
});
