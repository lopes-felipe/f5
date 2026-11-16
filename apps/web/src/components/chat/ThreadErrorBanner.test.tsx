import { describe, expect, it } from "vitest";
import { getThreadErrorBannerMessage } from "./ThreadErrorBanner";

describe("getThreadErrorBannerMessage", () => {
  it("preserves whitespace in the readable nested message", () => {
    const message = "  Unsupported model.\nChoose another model.  ";
    expect(
      getThreadErrorBannerMessage(
        " \n" + JSON.stringify({ error: { message, code: "bad" } }) + "\t ",
      ),
    ).toBe(message);
  });
  it.each([
    "  Could not start.\nTry again.  ",
    '{"error":{"message":"Cut off"',
    '{"message":"Top-level message","status":400}',
    '{"error":{"message":" \\n\\t ","code":"bad"}}',
    '{"error":{"message":42}}',
    '{"error":null}',
    "null",
    "[]",
  ])("preserves unrecognized diagnostics: %s", (error) => {
    expect(getThreadErrorBannerMessage(error)).toBe(error);
  });
  it("does not recursively unwrap the selected message", () => {
    const message = JSON.stringify({ error: { message: "Inner message" } });
    expect(getThreadErrorBannerMessage(JSON.stringify({ error: { message } }))).toBe(message);
  });
});
