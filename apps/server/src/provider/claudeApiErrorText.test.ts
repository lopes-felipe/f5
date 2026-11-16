import { describe, expect, it } from "vitest";

import { claudeApiErrorText, MAX_CLAUDE_API_ERROR_TEXT_LENGTH } from "./claudeApiErrorText.ts";

const apiError = (result: string) =>
  claudeApiErrorText({ subtype: "success", terminal_reason: "api_error", result });

describe("claudeApiErrorText", () => {
  it("only reads success results that ended with an API Error", () => {
    expect(
      claudeApiErrorText({
        subtype: "success",
        terminal_reason: "completed",
        result: "API Error: x",
      }),
    ).toBeUndefined();
    expect(
      claudeApiErrorText({
        subtype: "error_during_execution",
        terminal_reason: "api_error",
        result: "API Error: x",
      }),
    ).toBeUndefined();
    expect(apiError("Something else failed")).toBeUndefined();
    expect(apiError("")).toBeUndefined();
    expect(apiError("  API Error: 500 boom \n")).toBe("API Error: 500 boom");
  });

  it("redacts URL credentials, queries and fragments, keeping trailing punctuation", () => {
    expect(apiError("API Error: see https://user:pass@api.example.com/v1?key=abc#frag).")).toBe(
      "API Error: see https://api.example.com/v1).",
    );
  });

  it("redacts bearer tokens, key fields, key=value pairs and sk- keys", () => {
    const text = apiError(
      'API Error: Bearer abc.def {"api_key":"secret-1","note":"ok"} token=secret-2 sk-abcdefghijklmnopqrstu',
    );
    expect(text).toBe(
      'API Error: Bearer [REDACTED] {"api_key":"[REDACTED]","note":"ok"} token=[REDACTED] [REDACTED]',
    );
  });

  it("blanks control characters but keeps tabs and newlines", () => {
    expect(apiError("API Error: a\u0007b\tc\nd\u007fe")).toBe("API Error: a b\tc\nd e");
  });

  it("caps the text after redaction, never splitting a surrogate pair", () => {
    const secret = `API Error: ${"x".repeat(470)} sk-${"a".repeat(40)}`;
    const capped = apiError(secret)!;
    expect(capped).toBe(`API Error: ${"x".repeat(470)} [REDACTED]`);

    const emoji = apiError(
      `API Error: ${"x".repeat(MAX_CLAUDE_API_ERROR_TEXT_LENGTH - 13)}😀tail`,
    )!;
    expect(emoji.length).toBeLessThanOrEqual(MAX_CLAUDE_API_ERROR_TEXT_LENGTH);
    expect(emoji.endsWith("…")).toBe(true);
    expect(emoji.at(-2)).toBe("x");
  });
});
