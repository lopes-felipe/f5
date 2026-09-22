import { DEFAULT_MODEL_BY_PROVIDER, CodexSettings } from "@t3tools/contracts";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { codexModels, withCodexIsolationCompatibility } from "./CodexDriver.ts";

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

it("refreshes compatibility notices without disabling sessions or replacing authentication failures", () => {
  const status = {
    provider: "codex" as const,
    available: true,
    status: "ready" as const,
    authStatus: "authenticated" as const,
    version: "0.147.0",
    checkedAt: new Date().toISOString(),
  };
  const newer = withCodexIsolationCompatibility(status, true);
  expect(newer).toMatchObject({
    available: true,
    status: "ready",
    authStatus: "authenticated",
    message: expect.stringContaining("0.147.0"),
  });
  expect(
    withCodexIsolationCompatibility({ ...status, version: "0.144.3" }, true).message,
  ).toBeUndefined();
  const signedOut = withCodexIsolationCompatibility(
    { ...status, status: "error", authStatus: "unauthenticated", message: "Please sign in." },
    true,
  );
  expect(signedOut).toMatchObject({
    available: true,
    authStatus: "unauthenticated",
    message: expect.stringMatching(/^Please sign in\./),
  });
  expect(withCodexIsolationCompatibility(status, false)).toBe(status);
  expect(withCodexIsolationCompatibility({ ...status, version: "0.144.2" }, true).available).toBe(
    false,
  );
});
