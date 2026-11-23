import * as AcpErrors from "effect-acp/errors";
import { Cause } from "effect";
import { describe, expect, it } from "vitest";
import { antigravityDiscoveryFailureClass } from "./Drivers/AntigravityDriver.ts";
import { antigravityRuntimeHealthDetails } from "./Layers/AntigravityProvider.ts";
import { ANTIGRAVITY_STALE_AUTH_MESSAGE } from "./antigravityAuthSupport.ts";
import { antigravityPrivateFormatGate } from "./antigravityPrivateFormats.ts";

describe("Antigravity private-format gate", () => {
  it("enables the readers from the floor version up, with no per-release list", () => {
    for (const version of ["1.5.13", "1.5.14", "1.5.15", "1.6.0", "2.0", " 1.5.13 "])
      expect(antigravityPrivateFormatGate(version).enabled).toBe(true);
    expect(antigravityPrivateFormatGate("1.5.15")).toEqual({ enabled: true, version: "1.5.15" });
    const older = antigravityPrivateFormatGate("1.5.12");
    expect(older.enabled).toBe(false);
    if (!older.enabled) expect(older.reason).toContain("1.5.12 is older than 1.5.13");
    expect(antigravityPrivateFormatGate("1.4.5").enabled).toBe(false);
    // A version F5 can't order is not trusted.
    const odd = antigravityPrivateFormatGate("1.6.0-beta");
    expect(odd.enabled).toBe(false);
    if (!odd.enabled) expect(odd.reason).toContain("unrecognised version");
    expect(antigravityPrivateFormatGate(null).enabled).toBe(false);
    expect(antigravityPrivateFormatGate("  ").enabled).toBe(false);
  });

  it("reports the runtime source, version and reader gate", () => {
    expect(antigravityRuntimeHealthDetails("1.5.13", "1.5.13")).toEqual([
      { label: "Runtime", value: "Managed 1.5.13 (bundled with F5)" },
      { label: "Native readers", value: "On (1.5.13 or newer)" },
    ]);
    const update = antigravityRuntimeHealthDetails("1.6.0", "1.5.13");
    expect(update).toEqual([
      { label: "Runtime", value: "Managed 1.6.0 (installed update)" },
      { label: "Native readers", value: "On (1.5.13 or newer)" },
    ]);
    expect(antigravityRuntimeHealthDetails("1.5.12", "1.5.13")[1]?.value).toMatch(
      /^Off\. Antigravity 1\.5\.12 is older than 1\.5\.13/,
    );
    expect(antigravityRuntimeHealthDetails(null, "1.5.13")).toEqual([]);
  });
});

describe("Antigravity discovery failure classes", () => {
  it("names the class without the failure message", () => {
    const transport = (detail: string) =>
      Cause.fail(new AcpErrors.AcpTransportError({ detail, cause: undefined }));
    expect(antigravityDiscoveryFailureClass(Cause.fail(new Cause.TimeoutError()))).toBe(
      "Timed out",
    );
    expect(antigravityDiscoveryFailureClass(transport(ANTIGRAVITY_STALE_AUTH_MESSAGE))).toBe(
      "Sign-in settings changed",
    );
    expect(antigravityDiscoveryFailureClass(transport("Account change in progress."))).toBe(
      "Account change in progress",
    );
    expect(
      antigravityDiscoveryFailureClass(transport("spawn /Users/someone/secret/agy ENOENT")),
    ).toBe("Agent error");
    expect(antigravityDiscoveryFailureClass(Cause.die(new Error("token=abc")))).toBe(
      "Unexpected error",
    );
  });
});
