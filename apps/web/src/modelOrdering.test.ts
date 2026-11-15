import { describe, expect, it } from "vitest";
import { ProviderInstanceId } from "@t3tools/contracts";

import {
  providerModelKey,
  sortModelsForProviderInstance,
  sortProviderModelItems,
} from "./modelOrdering";

const CODEX_WORK_ID = ProviderInstanceId.make("codex_work");
const CLAUDE_ID = ProviderInstanceId.make("claudeAgent");

describe("model ordering", () => {
  it("orders known families by capability tier and descending versions", () => {
    expect(
      sortModelsForProviderInstance(
        [
          "claude-haiku-5-5",
          "claude-fable-5",
          "claude-opus-5-5",
          "claude-fable-5-2",
          "claude-sonnet-5-5",
        ].map((slug) => ({ slug })),
      ).map((model) => model.slug),
    ).toEqual([
      "claude-fable-5-2",
      "claude-fable-5",
      "claude-opus-5-5",
      "claude-sonnet-5-5",
      "claude-haiku-5-5",
    ]);
    expect(
      sortModelsForProviderInstance(
        ["gpt-6-luna", "gpt-6.1-terra", "gpt-6-sol", "gpt-6.1-sol", "gpt-6-astra"].map((slug) => ({
          slug,
        })),
      ).map((model) => model.slug),
    ).toEqual(["gpt-6-astra", "gpt-6.1-sol", "gpt-6-sol", "gpt-6.1-terra", "gpt-6-luna"]);
  });
  it("groups favorites first while preserving provider model order inside each group", () => {
    const models = [
      { slug: "gpt-5.5" },
      { slug: "gpt-5.4-mini" },
      { slug: "crest-alpha" },
      { slug: "gpt-5.3-codex" },
    ];

    expect(
      sortModelsForProviderInstance(models, {
        favoriteModels: ["gpt-5.5", "gpt-5.4-mini", "crest-alpha"],
        groupFavorites: true,
        modelOrder: ["gpt-5.4-mini", "gpt-5.5", "crest-alpha", "gpt-5.3-codex"],
      }).map((model) => model.slug),
    ).toEqual(["gpt-5.4-mini", "gpt-5.5", "crest-alpha", "gpt-5.3-codex"]);
  });

  it("sorts the favorites view by provider order, then provider model order", () => {
    const items = [
      { instanceId: CODEX_WORK_ID, slug: "gpt-5.4-mini" },
      { instanceId: CODEX_WORK_ID, slug: "gpt-5.5" },
      { instanceId: CODEX_WORK_ID, slug: "crest-alpha" },
      { instanceId: CLAUDE_ID, slug: "claude-opus-4-6" },
    ];
    const favoriteKeys = [
      providerModelKey(CODEX_WORK_ID, "gpt-5.5"),
      providerModelKey(CLAUDE_ID, "claude-opus-4-6"),
      providerModelKey(CODEX_WORK_ID, "gpt-5.4-mini"),
      providerModelKey(CODEX_WORK_ID, "crest-alpha"),
    ];

    expect(
      sortProviderModelItems(items, {
        favoriteModelKeys: favoriteKeys,
        instanceOrder: [CODEX_WORK_ID, CLAUDE_ID],
      }).map((item) => item.slug),
    ).toEqual(["gpt-5.4-mini", "gpt-5.5", "crest-alpha", "claude-opus-4-6"]);
  });
});
