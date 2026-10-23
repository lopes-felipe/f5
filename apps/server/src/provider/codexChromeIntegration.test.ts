import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as certification from "@t3tools/shared/providerIntegrationCertification";
import {
  CODEX_CHROME_NEEDS_FULL_ACCESS,
  CODEX_CHROME_NEEDS_ISOLATED_HOME,
} from "../computer/codexNativeIntegrations";
import {
  codexChromeEligibility,
  codexChromeFingerprint,
  effectiveCodexHome,
} from "./codexChromeIntegration";

const record = certification.PROVIDER_INTEGRATION_RECORDS["codex-chrome"][0]!;
let root: string | undefined;
afterEach(async () => {
  vi.restoreAllMocks();
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});
const certify = () =>
  vi.spyOn(certification, "certifiedIntegrationRecord").mockReturnValue({
    ...record,
    evidenceId: "fixture",
    toolInventorySha256: "a".repeat(64),
  } as never);

describe("Codex Chrome eligibility", () => {
  it("reads nothing while the record is uncertified", async () => {
    const inspect = vi.fn();
    const result = await codexChromeEligibility({
      codexHome: "/isolated",
      userHome: "/Users/me",
      platform: "darwin",
      arch: "arm64",
      runtimeMode: "full-access",
      inspect,
    });
    expect(result).toMatchObject({ eligible: false });
    if (!certification.isIntegrationCertified("codex-chrome", "darwin", "arm64"))
      expect(inspect).not.toHaveBeenCalled();
  });

  it("requires Full access and an isolated CODEX_HOME", async () => {
    certify();
    root = await mkdtemp(join(tmpdir(), "f5-codex-chrome-"));
    const inspect = vi.fn(async () => ({
      available: false as const,
      state: "version" as const,
      reason: "x",
    }));
    const base = {
      userHome: root,
      platform: "darwin",
      arch: "arm64",
      inspect,
      runtimeMode: "preflight" as const,
    };
    expect(
      await codexChromeEligibility({
        ...base,
        codexHome: "/isolated",
        runtimeMode: "auto-accept-edits",
      }),
    ).toMatchObject({
      eligible: false,
      reason: CODEX_CHROME_NEEDS_FULL_ACCESS,
    });
    expect(await codexChromeEligibility({ ...base, codexHome: undefined })).toMatchObject({
      reason: CODEX_CHROME_NEEDS_ISOLATED_HOME,
    });
    expect(
      await codexChromeEligibility({ ...base, codexHome: join(root, ".codex") }),
    ).toMatchObject({
      reason: CODEX_CHROME_NEEDS_ISOLATED_HOME,
    });
    expect(inspect).not.toHaveBeenCalled();
    expect(
      await codexChromeEligibility({
        ...base,
        codexHome: join(root, "isolated"),
        runtimeMode: "full-access",
      }),
    ).toMatchObject({
      eligible: false,
      reason: "x",
    });
    expect(inspect).toHaveBeenCalledTimes(1);
  });

  // POSIX home paths; Codex Chrome is macOS only.
  it.skipIf(process.platform === "win32")("uses the CODEX_HOME Codex itself runs with", () => {
    expect(effectiveCodexHome("/configured", { CODEX_HOME: "/inherited" })).toBe("/configured");
    // An isolated profile (or the user) already points Codex at its own home.
    expect(effectiveCodexHome(undefined, { CODEX_HOME: "/inherited" })).toBe("/inherited");
    expect(effectiveCodexHome(undefined, {})).toBe(join(homedir(), ".codex"));
  });

  it("restarts only when the toggle changes", () => {
    expect(codexChromeFingerprint(true)).not.toBe(codexChromeFingerprint(false));
    expect(codexChromeFingerprint(true)).toBe(codexChromeFingerprint(true));
  });
});
