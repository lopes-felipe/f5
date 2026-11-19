import { expect, it } from "vitest";
import { generateApiText, makeApiTextGeneration, type ApiFetcher } from "./ApiTextGeneration.ts";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type TextGeneratorConfig,
} from "@t3tools/contracts";
import { Effect, Schema } from "effect";
import { makeTextGenerationFromRegistry } from "./TextGenerationLive.ts";
const config: TextGeneratorConfig = {
  kind: "openaiCompatible",
  label: "test",
  baseUrl: "https://example.test/v1",
  apiKey: "secret",
  enabled: true,
  models: ["model"],
};
it("routes structured cleanup without a provider session or workspace and validates its schema", async () => {
  let request: RequestInit | undefined;
  const api = makeApiTextGeneration(config, async (_url, init) => {
    request = init;
    return Response.json({ choices: [{ message: { content: '{"cleaned":"Hello"}' } }] });
  });
  const text = makeTextGenerationFromRegistry({
    getInstance: () =>
      Effect.succeed({ driverKind: ProviderDriverKind.make("textGenerator"), textGeneration: api }),
  });
  const result = await Effect.runPromise(
    text.generateStructuredJson({
      cwd: "/does/not/exist",
      operation: "cleanup",
      prompt: "Clean up hello",
      isolation: "no-workspace",
      modelSelection: { instanceId: ProviderInstanceId.make("textgen_test"), model: "model" },
      outputSchema: Schema.Struct({ cleaned: Schema.String }),
    }),
  );
  expect(result).toEqual({ cleaned: "Hello" });
  expect(JSON.parse(String(request?.body)).messages[0].content).toContain('"cleaned"');
  expect(JSON.parse(String(request?.body))).not.toHaveProperty("tools");
  const invalid = makeApiTextGeneration(config, async () =>
    Response.json({ choices: [{ message: { content: '{"wrong":1}' } }] }),
  );
  expect(
    await Effect.runPromise(
      invalid
        .generateStructuredJson({
          cwd: "",
          operation: "cleanup",
          prompt: "",
          outputSchema: Schema.Struct({ cleaned: Schema.String }),
        })
        .pipe(Effect.result),
    ),
  ).toMatchObject({ _tag: "Failure", failure: { kind: "invalid-output" } });
});
it("uses the OpenAI protocol without redirects", async () => {
  let seen: RequestInit | undefined;
  const fetcher: ApiFetcher = async (url, init) => {
    expect(String(url)).toBe("https://example.test/v1/chat/completions");
    seen = init;
    return Response.json({ choices: [{ finish_reason: "stop", message: { content: " OK " } }] });
  };
  expect(await generateApiText(config, "model", "prompt", fetcher)).toBe("OK");
  expect(seen?.redirect).toBe("error");
  expect(seen?.headers).toMatchObject({ Authorization: "Bearer secret" });
  expect(JSON.parse(String(seen?.body))).toEqual({
    model: "model",
    messages: [{ role: "user", content: "prompt" }],
  });
});
it("uses Anthropic text blocks and rejects truncated replies", async () => {
  const fetcher: ApiFetcher = async (_url, init) => {
    expect(init?.headers).toMatchObject({
      "x-api-key": "secret",
      "anthropic-version": "2023-06-01",
    });
    return Response.json({
      stop_reason: "end_turn",
      content: [
        { type: "thinking", text: "hidden" },
        { type: "text", text: "OK" },
      ],
    });
  };
  expect(await generateApiText({ ...config, kind: "anthropic" }, "model", "prompt", fetcher)).toBe(
    "OK",
  );
  await expect(
    generateApiText(config, "model", "prompt", async () =>
      Response.json({ choices: [{ finish_reason: "length", message: { content: "partial" } }] }),
    ),
  ).rejects.toThrow("output limit");
});
it("fails closed for missing keys and API errors", async () => {
  await expect(
    generateApiText({ ...config, apiKey: "", apiKeyRedacted: true }, "model", "prompt"),
  ).rejects.toThrow("stored API key");
  await expect(
    generateApiText(
      config,
      "model",
      "prompt",
      async () => new Response("private error", { status: 401 }),
    ),
  ).rejects.toThrow("HTTP 401");
});
