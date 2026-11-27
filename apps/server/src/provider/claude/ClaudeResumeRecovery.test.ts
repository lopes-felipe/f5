import { describe, expect, it } from "vitest";

import {
  isClaudeApiKeyFailureText,
  isClaudeAuthFailureText,
  isClaudeMissingConversationError,
} from "./ClaudeResumeRecovery.ts";
import { isInterruptedResult, resultErrorsText } from "./ClaudeSdkResultHelpers.ts";

describe("ClaudeResumeRecovery & ClaudeSdkResultHelpers", () => {
  it("classifies Claude auth and missing-conversation failure text", () => {
    expect(isClaudeApiKeyFailureText("Invalid API key provided")).toBe(true);
    expect(isClaudeAuthFailureText("Please run /login to authenticate")).toBe(true);
    expect(
      isClaudeMissingConversationError("No conversation found with session ID abc", "abc"),
    ).toBe(true);
  });

  it("classifies interrupted SDK result payloads without filesystem imports", () => {
    expect(
      resultErrorsText({
        subtype: "error_during_execution",
        is_error: true,
        errors: ["Request Was Aborted"],
      } as never),
    ).toBe("request was aborted");
    expect(
      isInterruptedResult({
        subtype: "error_during_execution",
        is_error: false,
        errors: ["Interrupted by user"],
      } as never),
    ).toBe(true);
  });
});
