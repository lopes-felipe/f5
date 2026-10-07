import { describe, expect, it } from "vitest";

import { isClaudeMissingResumePointError, isProviderResumeFailureText } from "./resumeFailure.ts";

describe("resumeFailure", () => {
  it("recognizes a missing Claude resume point", () => {
    const text = "No message found with message.uuid of: ee6d2082-0000-4000-8000-000000000000";
    expect(isClaudeMissingResumePointError(text)).toBe(true);
    expect(isProviderResumeFailureText(text)).toBe(true);
  });

  it("recognizes a missing conversation and ignores transient failures", () => {
    expect(isProviderResumeFailureText("No conversation found with session ID: abc")).toBe(true);
    expect(isProviderResumeFailureText("503 overloaded")).toBe(false);
    expect(isProviderResumeFailureText(null)).toBe(false);
  });
});
