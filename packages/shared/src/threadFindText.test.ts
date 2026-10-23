import { expect, it } from "vitest";
import { searchableThreadSegments } from "./threadFindText";
it("finds text across inline formatting without indexing link targets or definitions", () => {
  expect(
    searchableThreadSegments(
      "Hello **bold** [world](https://hidden.test/secret) &amp; `code`\n\n[ref]: https://hidden.test/other",
    ),
  ).toEqual(["Hello bold world & code"]);
});
it("keeps separate blocks and code bodies separate while preserving code newlines", () => {
  expect(
    searchableThreadSegments("First\n\nSecond\n\n```ts\nconst a = 1\nconst b = 2\n```"),
  ).toEqual(["First", "Second", "const a = 1\nconst b = 2"]);
});
it("indexes table cells and task text but not hidden HTML", () => {
  expect(
    searchableThreadSegments(
      "| A | B |\n| - | - |\n| one | two |\n\n- [x] Done\n\n<!-- hidden -->",
    ),
  ).toEqual(["A", "B", "one", "two", "Done"]);
});
