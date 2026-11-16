import type { ModelCatalogEntry } from "@muse-code/sdk/dist/src/msp.js";
import { MuseSettings } from "@t3tools/contracts";
import { runtimeModeCapabilities } from "@t3tools/shared/runtimeMode";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import {
  buildInitialMuseProviderSnapshot,
  museAuthStatus,
  museModelsFromCatalog,
} from "./MuseProvider.ts";

describe("museAuthStatus", () => {
  it("reports the environment API key first", () => {
    expect(museAuthStatus({ apiKeySet: true, signedIn: false })).toMatchObject({
      status: "authenticated",
      label: "API key (environment)",
    });
  });

  it("reports browser sign-in state", () => {
    expect(museAuthStatus({ apiKeySet: false, signedIn: true }).label).toBe("Signed in");
    expect(museAuthStatus({ apiKeySet: false, signedIn: false }).label).toBe("Not signed in");
    expect(museAuthStatus({ apiKeySet: false, signedIn: undefined }).status).toBe("unknown");
  });
});

describe("museModelsFromCatalog", () => {
  it("uses the reported catalog with its effort variants", () => {
    const models = museModelsFromCatalog([
      { modelId: "muse-spark-2", displayLabel: "Muse Spark 2", variants: ["low", "high"] },
      { modelId: "muse-spark-2", displayLabel: "dup" },
    ] as unknown as ModelCatalogEntry[]);
    expect(models).toHaveLength(1);
    expect(models[0]?.name).toBe("Muse Spark 2");
    const descriptor = models[0]?.capabilities?.optionDescriptors?.[0];
    expect(descriptor?.id).toBe("reasoningEffort");
    expect(descriptor?.type === "select" ? descriptor.options.map((o) => o.id) : []).toEqual([
      "low",
      "high",
    ]);
  });
});

it("starts from the built-in Muse Spark 1.3 model", () => {
  const snapshot = buildInitialMuseProviderSnapshot(Schema.decodeSync(MuseSettings)({}));
  expect(snapshot.displayName).toBe("Muse Code");
  expect(snapshot.models.map((model) => model.slug)).toEqual(["muse-spark-1.3"]);
});

it("never offers approval-required for Muse", () => {
  expect([...runtimeModeCapabilities("muse")].toSorted()).toEqual([
    "auto-accept-edits",
    "full-access",
  ]);
});
