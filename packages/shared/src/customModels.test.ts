import { describe, expect, it } from "vitest";
import { normalizeCustomModels, readCustomModels } from "./customModels";

describe("custom model metadata", () => {
  it("keeps names and descriptors while normalizing and deduplicating slugs", () => {
    const capabilities = { optionDescriptors: [] };
    expect(
      normalizeCustomModels(
        [{ slug: " custom/model ", name: " Review ", capabilities }, "custom/model", "builtin"],
        "codex",
        new Set(["builtin"]),
      ),
    ).toEqual([{ slug: "custom/model", name: "Review", capabilities }]);
  });
  it("reads legacy strings alongside structured entries without accepting malformed metadata", () => {
    expect(
      readCustomModels({
        customModels: [
          "old",
          { slug: "new", name: "My model" },
          null,
          { slug: 42 },
          { slug: "invalid", capabilities: { optionDescriptors: [null] } },
        ],
      }),
    ).toEqual(["old", { slug: "new", name: "My model" }]);
  });
});
