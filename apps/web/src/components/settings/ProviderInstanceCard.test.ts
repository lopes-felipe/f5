import { describe, expect, it } from "vitest";
import { ProviderDriverKind, type ServerProviderModel } from "@t3tools/contracts";

import { deriveProviderModelsForDisplay } from "./ProviderInstanceCard";

describe("deriveProviderModelsForDisplay", () => {
  it("uses current config custom models instead of stale live custom rows", () => {
    const liveModels: ReadonlyArray<ServerProviderModel> = [
      {
        slug: "server-model",
        name: "Server Model",
        isCustom: false,
        capabilities: null,
      },
      {
        slug: "removed-custom",
        name: "Removed Custom",
        isCustom: true,
        capabilities: null,
      },
      {
        slug: "kept-custom",
        name: "Kept Custom",
        isCustom: true,
        capabilities: null,
      },
    ];

    expect(
      deriveProviderModelsForDisplay({
        liveModels,
        customModels: ["kept-custom"],
      }).map((model) => model.slug),
    ).toEqual(["server-model", "kept-custom"]);
  });

  it("canonicalizes and deduplicates Claude custom aliases without reviving gated built-ins", () => {
    const liveModels: ReadonlyArray<ServerProviderModel> = [
      {
        slug: "claude-fable-5",
        name: "Claude Fable 5",
        isCustom: false,
        capabilities: null,
      },
      {
        slug: "custom/claude-model",
        name: "Custom Claude Model",
        isCustom: true,
        capabilities: null,
      },
    ];

    expect(
      deriveProviderModelsForDisplay({
        liveModels,
        customModels: [
          "opus",
          "opus-5",
          "claude-opus-5[1m]",
          "custom/claude-model",
          " custom/claude-model ",
        ],
        driverKind: ProviderDriverKind.make("claudeAgent"),
      }).map((model) => model.slug),
    ).toEqual(["claude-fable-5", "custom/claude-model"]);
  });
});
