import { PROVIDER_SEND_TURN_MAX_INPUT_CHARS } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import { getMessageTextLengthIssue, getProviderTurnInputLengthIssue } from "./providerInput";
import { THREAD_REFERENCE_CONTEXT_MAX_CHARS } from "./threadReferences";

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

describe("getMessageTextLengthIssue", () => {
  const reference = "[Source](f5://thread/source-1)";

  it("uses the full limit when the text references no thread", () => {
    expect(getMessageTextLengthIssue("x".repeat(PROVIDER_SEND_TURN_MAX_INPUT_CHARS))).toBe(null);
  });

  it("reserves room for referenced-thread context", () => {
    const limit = PROVIDER_SEND_TURN_MAX_INPUT_CHARS - THREAD_REFERENCE_CONTEXT_MAX_CHARS;
    const atLimit = `${reference}${"x".repeat(limit - reference.length)}`;
    expect(getMessageTextLengthIssue(atLimit)).toBe(null);
    const issue = getMessageTextLengthIssue(`${atLimit}x`);
    expect(issue).toMatchObject({ actualChars: limit + 1, maxChars: limit });
    expect(issue?.message).toContain("room for referenced-thread context");
  });
});
