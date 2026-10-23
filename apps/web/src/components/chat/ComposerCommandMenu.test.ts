import { expect, it } from "vitest";

import { composerSuggestionOptionId } from "./ComposerCommandMenu";

it("keeps whitespace, escape-like paths, and malformed UTF-16 distinct", () => {
  const paths = [
    "docs/my file.md",
    "docs/my_file.md",
    "docs/my%20file.md",
    "docs/my\tfile.md",
    "docs/\ud800.md",
    "docs/\ud801.md",
    "docs/\udc00.md",
    "docs/�.md",
    "docs/\\ud800.md",
    "docs/🚀.md",
  ];
  const ids = paths.map((path) => composerSuggestionOptionId("suggestions", `path:file:${path}`));

  expect(new Set(ids).size).toBe(paths.length);
  for (const id of ids) expect(id).not.toMatch(/\s|[\ud800-\udfff]/u);
  expect(composerSuggestionOptionId("other-composer", paths[0]!)).not.toBe(
    composerSuggestionOptionId("suggestions", paths[0]!),
  );
});
