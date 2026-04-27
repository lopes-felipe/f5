import { describe, expect, it } from "vitest";

import {
  clearAnthropicModelContextWindowCatalogCacheForTest,
  fetchAnthropicModelContextWindowCatalog,
  readClaudeModelContextWindowCatalog,
  lookupModelContextWindowTokens,
  readCodexModelContextWindowCatalog,
  readConfiguredModelContextWindowTokens,
  resolveModelContextWindowTokens,
} from "./modelContextWindowMetadata.ts";

describe("modelContextWindowMetadata", () => {
  it("reads configured model context windows from nested metadata", () => {
    expect(
      readConfiguredModelContextWindowTokens({
        metadata: {
          limits: {
            max_input_tokens: 321_000,
          },
        },
      }),
    ).toBe(321_000);
  });

  it("builds a codex model catalog from provider-reported limits", () => {
    const catalog = readCodexModelContextWindowCatalog({
      data: [
        {
          id: "gpt-5.5",
          limits: {
            contextWindowTokens: 987_000,
          },
        },
      ],
    });

    expect(lookupModelContextWindowTokens({ provider: "codex", model: "gpt-5.5", catalog })).toBe(
      987_000,
    );
  });

  it("builds a claude model catalog from supported-model metadata", () => {
    const catalog = readClaudeModelContextWindowCatalog([
      {
        value: "claude-opus-4-7",
        capabilities: {
          max_input_tokens: 1_000_000,
        },
      },
    ]);

    expect(
      lookupModelContextWindowTokens({
        provider: "claudeAgent",
        model: "claude-opus-4-7",
        catalog,
      }),
    ).toBe(1_000_000);
  });

  it("fetches a claude model catalog from the Anthropic models API", async () => {
    clearAnthropicModelContextWindowCatalogCacheForTest();
    const fetchCalls: Array<string> = [];
    const catalog = await fetchAnthropicModelContextWindowCatalog({
      apiKey: "test-key",
      fetchImpl: async (input) => {
        fetchCalls.push(String(input));
        return new Response(
          JSON.stringify({
            data: [
              {
                id: "claude-opus-4-7",
                max_input_tokens: 1_000_000,
              },
            ],
          }),
          {
            status: 200,
            headers: {
              "content-type": "application/json",
            },
          },
        );
      },
    });

    expect(fetchCalls).toEqual(["https://api.anthropic.com/v1/models"]);
    expect(
      lookupModelContextWindowTokens({
        provider: "claudeAgent",
        model: "claude-opus-4-7",
        catalog,
      }),
    ).toBe(1_000_000);
  });

  it("falls back to the shared estimate when the provider does not report a limit", () => {
    expect(
      resolveModelContextWindowTokens({
        provider: "claudeAgent",
        model: "claude-opus-4-7",
      }),
    ).toBe(1_000_000);
  });
});
