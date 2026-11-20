import { expect, it } from "vitest";
import { buildPrCommentContext } from "./PrAddCommentToChat";
it("adds reference and location without a fix instruction", () => {
  const prompt = buildPrCommentContext(
    { title: "Test", url: "https://github.com/a/b/pull/1" },
    "why?",
    "a.ts",
    12,
  );
  expect(prompt).toContain("a.ts:12");
  expect(prompt).toContain("why?");
  expect(prompt).not.toMatch(/fix|assess|review this/i);
});
