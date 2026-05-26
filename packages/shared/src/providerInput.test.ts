import { PROVIDER_SEND_TURN_MAX_INPUT_CHARS } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import { getProviderTurnInputLengthIssue } from "./providerInput";

describe("getProviderTurnInputLengthIssue", () => {
  it("accepts input at the provider limit", () => {
    expect(getProviderTurnInputLengthIssue("x".repeat(PROVIDER_SEND_TURN_MAX_INPUT_CHARS))).toBe(
      null,
    );
  });

  it("returns a concise user-facing issue for oversized input", () => {
    const issue = getProviderTurnInputLengthIssue(
      ` ${"x".repeat(PROVIDER_SEND_TURN_MAX_INPUT_CHARS + 1)} `,
    );

    expect(issue).toMatchObject({
      actualChars: PROVIDER_SEND_TURN_MAX_INPUT_CHARS + 1,
      maxChars: PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
    });
    expect(issue?.message).toContain("120,000 character provider input limit");
    expect(issue?.message.length).toBeLessThan(240);
  });
});
