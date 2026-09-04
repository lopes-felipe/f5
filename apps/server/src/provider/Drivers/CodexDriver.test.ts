import { DEFAULT_MODEL_BY_PROVIDER, CodexSettings } from "@t3tools/contracts";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { codexModels } from "./CodexDriver.ts";

describe("codexModels", () => {
  it("keeps the shared Codex default as the first model", () => {
    const settings = Schema.decodeSync(CodexSettings)({});

    expect(codexModels(settings)[0]?.slug).toBe(DEFAULT_MODEL_BY_PROVIDER.codex);
  });

  it("deduplicates normalized custom model slugs against built-ins and each other", () => {
    const settings = Schema.decodeSync(CodexSettings)({
      customModels: ["gpt-6-astra", "5.6", "custom/internal", " custom/internal "],
    });
    const models = codexModels(settings);
    const slugs = models.map((model) => model.slug);

    expect(slugs.filter((slug) => slug === "gpt-6-astra")).toHaveLength(1);
    expect(slugs.filter((slug) => slug === "gpt-5.6-sol")).toHaveLength(1);
    expect(slugs.filter((slug) => slug === "custom/internal")).toHaveLength(1);
    expect(models.find((model) => model.slug === "custom/internal")?.capabilities).toEqual({
      optionDescriptors: [],
    });
  });
});
