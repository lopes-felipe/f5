import { expect, it } from "vitest";
import { foldedPasteFile } from "./textPaste";
it("folds by UTF-8 bytes and input length with unique names", async () => {
  expect(foldedPasteFile("hello", "", 120000, [])).toBeNull();
  const file = foldedPasteFile("界".repeat(11000), "", 120000, ["pasted-text.txt"]);
  expect(file?.name).toBe("pasted-text-2.txt");
  expect(await file?.text()).toBe("界".repeat(11000));
  expect(foldedPasteFile("hello", "1234567890", 12, [])?.name).toBe("pasted-text.txt");
});
