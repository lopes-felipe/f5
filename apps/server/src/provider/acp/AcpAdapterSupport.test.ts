import { describe, expect, it } from "vitest";
import * as EffectAcpErrors from "effect-acp/errors";
import { ProviderDriverKind } from "@t3tools/contracts";

import { acpPermissionOutcome, mapAcpToAdapterError } from "./AcpAdapterSupport.ts";

describe("AcpAdapterSupport", () => {
  it("maps ACP approval decisions to permission outcomes", () => {
    const options = [
      { kind: "allow_once", optionId: "once-id", name: "Allow" },
      { kind: "allow_always", optionId: "always-id", name: "Always" },
      { kind: "reject_once", optionId: "reject-id", name: "Reject" },
    ] as const;
    expect(acpPermissionOutcome("accept", options)).toBe("once-id");
    expect(acpPermissionOutcome("acceptForSession", options)).toBe("always-id");
    expect(acpPermissionOutcome("acceptForSession", [options[0], options[2]])).toBe("once-id");
    expect(acpPermissionOutcome("decline", options)).toBe("reject-id");
    expect(acpPermissionOutcome("acceptForSession", [options[2]])).toBeUndefined();
    expect(acpPermissionOutcome("cancel", options)).toBeUndefined();
  });

  it("maps ACP request errors to provider adapter request errors", () => {
    const error = mapAcpToAdapterError(
      ProviderDriverKind.make("cursor"),
      "thread-1" as never,
      "session/prompt",
      new EffectAcpErrors.AcpRequestError({
        code: -32602,
        errorMessage: "Invalid params",
      }),
    );

    expect(error._tag).toBe("ProviderAdapterRequestError");
    expect(error.message).toContain("Invalid params");
  });
});

it("bounds setup errors but preserves scrubbed runtime diagnostics", () => {
  const error = EffectAcpErrors.AcpRequestError.authRequired("Usage limit: secret");
  const scrub = (value: string) => value.replaceAll("secret", "[redacted]");
  expect(
    mapAcpToAdapterError("cursor", "t" as never, "session/new", error, scrub, true).message,
  ).toContain("ACP_REQUEST_FAILED (-32000)");
  expect(
    mapAcpToAdapterError("cursor", "t" as never, "session/prompt", error, scrub).message,
  ).toContain("Usage limit: [redacted]");
});

it("keeps non-catalog setup failures readable with a scrubbed diagnostic cause", () => {
  const error = EffectAcpErrors.AcpRequestError.authRequired("Authentication required: secret");
  const mapped = mapAcpToAdapterError("cursor", "t" as never, "session/new", error, (value) =>
    value.replaceAll("secret", "[redacted]"),
  );
  expect(mapped.message).toContain("Authentication required: [redacted]");
  expect(mapped.cause).toMatchObject({
    code: -32000,
    message: "Authentication required: [redacted]",
  });
  expect(JSON.stringify(mapped)).not.toContain("secret");
});
