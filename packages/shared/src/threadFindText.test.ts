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
it("skips a GFM alert marker, which renders as a title, and keeps the alert body", () => {
  expect(searchableThreadSegments("> [!WARNING]\n> Warning: back up first.")).toEqual([
    "Warning: back up first.",
  ]);
  expect(searchableThreadSegments("> [!note]\n>\n> Body")).toEqual(["Body"]);
  expect(searchableThreadSegments("> [!FOO]\n> Body")).toEqual(["[!FOO] Body"]);
  expect(searchableThreadSegments("> > [!NOTE]\n> > Nested")).toEqual(["[!NOTE] Nested"]);
  // A marker with no body is a plain blockquote, so its text is searchable.
  expect(searchableThreadSegments("> [!NOTE]")).toEqual(["[!NOTE]"]);
});
it("keeps alert markers searchable where they are shown literally (user bubbles)", () => {
  expect(
    searchableThreadSegments("> [!WARNING]\n> Back up first.", { renderAlerts: false }),
  ).toEqual(["[!WARNING] Back up first."]);
});
