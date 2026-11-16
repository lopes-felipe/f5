import { expect, it } from "vitest";
import { DEFAULT_GIT_TEXT_GENERATION_MODEL_BY_PROVIDER } from "@t3tools/contracts";
import { resolveOneOffPromptRoute } from "./oneOffPromptRouting";

it("preserves a model owned by a known session provider", () => {
  expect(
    resolveOneOffPromptRoute({ model: "gpt-future-agent", sessionProviderName: "codex" }),
  ).toEqual({ provider: "codex", model: "gpt-future-agent" });
  expect(
    resolveOneOffPromptRoute({ model: "claude-opus-6", sessionProviderName: "claudeAgent" }),
  ).toEqual({ provider: "claudeAgent", model: "claude-opus-6" });
});
it("keeps the static guard on the inferred route", () => {
  expect(resolveOneOffPromptRoute({ model: "gpt-future-agent" }).model).toBe(
    DEFAULT_GIT_TEXT_GENERATION_MODEL_BY_PROVIDER.codex,
  );
});

it("rejects a clearly mismatched provider while keeping unfamiliar custom slugs", () => {
  expect(
    resolveOneOffPromptRoute({ model: "gpt-6-sol", sessionProviderName: "claudeAgent" }),
  ).toEqual({
    provider: "claudeAgent",
    model: DEFAULT_GIT_TEXT_GENERATION_MODEL_BY_PROVIDER.claudeAgent,
  });
  expect(
    resolveOneOffPromptRoute({ model: "claude-opus-6", sessionProviderName: "codex" }),
  ).toEqual({
    provider: "codex",
    model: DEFAULT_GIT_TEXT_GENERATION_MODEL_BY_PROVIDER.codex,
  });
  expect(
    resolveOneOffPromptRoute({ model: "my-custom-model", sessionProviderName: "claudeAgent" })
      .model,
  ).toBe("my-custom-model");
});
