import { describe, expect, it } from "vitest";
import { parsePiDiscoveredModels } from "./discovery.ts";
import { thinkingCapabilitiesForPiModel } from "./thinkingCapabilities.ts";

describe("Pi model discovery", () => {
  it("keeps provider identity and restricts the default thinking value to the active model", () => {
    const models = parsePiDiscoveredModels(
      {
        models: [
          { provider: "first", id: "shared", reasoning: true },
          { provider: "second", id: "shared", reasoning: true },
          { provider: "first", id: "shared", name: "duplicate" },
          { provider: "first", id: "other", reasoning: true },
          { provider: "", id: "invalid" },
          null,
        ],
      },
      { model: { provider: "second", id: "shared" }, thinkingLevel: "medium" },
    );
    expect(models.map((model) => [model.slug, model.subProvider])).toEqual([
      ["first/shared", "first"],
      ["second/shared", "second"],
      ["first/other", "first"],
    ]);
    const defaults = models.map((model) =>
      model.capabilities?.optionDescriptors?.flatMap((descriptor) =>
        descriptor.type === "select"
          ? descriptor.options.filter((option) => option.isDefault).map((option) => option.id)
          : [],
      ),
    );
    expect(defaults).toEqual([[], ["medium"], []]);
  });
  it("does not invent thinking for non-reasoning models or opt-in levels", () => {
    expect(thinkingCapabilitiesForPiModel({ reasoning: false }, "high").optionDescriptors).toEqual(
      [],
    );
    const descriptor = thinkingCapabilitiesForPiModel({ reasoning: true }, "xhigh")
      .optionDescriptors?.[0];
    expect(descriptor?.type).toBe("select");
    if (descriptor?.type !== "select") return;
    expect(descriptor.options.map((option) => option.id)).toEqual([
      "off",
      "minimal",
      "low",
      "medium",
      "high",
    ]);
    expect(descriptor.options.find((option) => option.isDefault)?.id).toBe("high");
  });
});
