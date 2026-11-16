import { describe, expect, it } from "vitest";

import { leadingSlashCommandName } from "./nativeCommandInput.ts";

describe("leadingSlashCommandName", () => {
  it.each([
    ["/compact", "compact"],
    ["  /model gpt-5", "model"],
    ["/skill:review the diff", "skill:review"],
    ["/review-pr 12\nmore", "review-pr"],
  ])("reads %j as the command %j", (text, name) => {
    expect(leadingSlashCommandName(text)).toBe(name);
  });

  it.each(["/Users/me/app.ts throws on start", "/", "/ compact", "fix /compact", "//comment"])(
    "treats %j as a prompt",
    (text) => {
      expect(leadingSlashCommandName(text)).toBeUndefined();
    },
  );
});
