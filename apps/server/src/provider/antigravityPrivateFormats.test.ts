import * as AcpErrors from "effect-acp/errors";
import { Cause } from "effect";
import { describe, expect, it } from "vitest";
import { antigravityDiscoveryFailureClass } from "./Drivers/AntigravityDriver.ts";
import { antigravityRuntimeHealthDetails } from "./Layers/AntigravityProvider.ts";
import { ANTIGRAVITY_STALE_AUTH_MESSAGE } from "./antigravityAuthSupport.ts";
import { antigravityPrivateFormatGate } from "./antigravityPrivateFormats.ts";

describe("Antigravity private-format gate", () => {
  it("enables the readers only for certified versions", () => {
    expect(antigravityPrivateFormatGate("1.5.13")).toEqual({ enabled: true, version: "1.5.13" });
    const newer = antigravityPrivateFormatGate("1.5.14");
    expect(newer.enabled).toBe(false);
    if (!newer.enabled) expect(newer.reason).toContain("1.5.14 is not yet certified");
    expect(antigravityPrivateFormatGate(null).enabled).toBe(false);
    expect(antigravityPrivateFormatGate("  ").enabled).toBe(false);
  });

  it("reports the runtime source, version and reader gate", () => {
    expect(antigravityRuntimeHealthDetails("1.5.13", "1.5.13")).toEqual([
      { label: "Runtime", value: "Managed 1.5.13 (bundled with F5)" },
      { label: "Native readers", value: "On, certified for 1.5.13" },
    ]);
    const update = antigravityRuntimeHealthDetails("1.6.0", "1.5.13");
    expect(update[0]).toEqual({ label: "Runtime", value: "Managed 1.6.0 (installed update)" });
    expect(update[1]?.value).toMatch(/^Off\. Antigravity 1\.6\.0 is not yet certified/);
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
