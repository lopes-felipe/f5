import type { TextGeneratorConfig } from "@t3tools/contracts";
import { textGeneratorRequestUrl } from "@t3tools/shared/serverSettings";
import { Effect, Schema } from "effect";
import { TextGenerationError } from "../Errors.ts";
import { makePromptTextGeneration, type StructuredTextRunner } from "../promptTextGeneration.ts";
import { extractJsonObject, toJsonSchemaObject } from "../Utils.ts";

export type ApiFetcher = (
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
) => Promise<Response>;
export async function generateApiText(
  config: TextGeneratorConfig,
  model: string,
  prompt: string,
  fetcher: ApiFetcher = fetch,
  signal?: AbortSignal,
): Promise<string> {
  if (!config.enabled) throw new Error("This text generator is disabled.");
  if (config.apiKeyRedacted && !config.apiKey)
    throw new Error("The stored API key is unavailable. Re-enter it in Settings.");
  const anthropic = config.kind === "anthropic";
  const response = await fetcher(textGeneratorRequestUrl(config), {
    method: "POST",
    redirect: "error",
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(120_000)])
      : AbortSignal.timeout(120_000),
    headers: {
      "Content-Type": "application/json",
      ...(anthropic
        ? {
            "x-api-key": config.apiKey,
            "anthropic-version": "2023-06-01",
          }
        : config.apiKey
          ? { Authorization: "Bearer " + config.apiKey }
          : {}),
    },
    body: JSON.stringify({
      model,
      ...(anthropic ? { max_tokens: 8192 } : {}),
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error("The model API returned HTTP " + response.status + ".");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("The model API returned no response.");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 2 * 1024 * 1024) throw new Error("The model API response exceeds 2 MiB.");
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
  const json: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  const record = (value: unknown): Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const result = record(json);
  let text: unknown;
  if (anthropic) {
    if (result.stop_reason === "max_tokens")
      throw new Error("The model API reached its output limit.");
    text = Array.isArray(result.content)
      ? result.content
          .flatMap((block) =>
            record(block).type === "text" && typeof record(block).text === "string"
              ? [record(block).text]
              : [],
          )
          .join("")
      : undefined;
  } else {
    const choice = record(Array.isArray(result.choices) ? result.choices[0] : undefined);
    if (choice.finish_reason === "length")
      throw new Error("The model API reached its output limit.");
    text = record(choice.message).content;
  }
  if (typeof text !== "string" || !text.trim()) throw new Error("The model API returned no text.");
  return text.trim();
}

export function makeApiTextGeneration(config: TextGeneratorConfig, fetcher: ApiFetcher = fetch) {
  const run: StructuredTextRunner = (input) =>
    Effect.gen(function* () {
      const text = yield* Effect.tryPromise({
        try: (signal) =>
          generateApiText(
            config,
            input.modelSelection?.model ?? input.model ?? config.models[0] ?? "",
            input.prompt +
              "\n\nReturn only JSON matching this schema:\n" +
              JSON.stringify(toJsonSchemaObject(input.outputSchemaJson)),
            fetcher,
            signal,
          ),
        catch: (cause) =>
          new TextGenerationError({
            operation: input.operation,
            detail:
              cause instanceof Error && !cause.message.includes(config.apiKey || "\0")
                ? cause.message
                : "The model API request failed.",
          }),
      });
      return yield* Schema.decodeEffect(Schema.fromJsonString(input.outputSchemaJson))(
        extractJsonObject(text),
      ).pipe(
        Effect.mapError(
          () =>
            new TextGenerationError({
              operation: input.operation,
              detail: "The model API returned invalid structured output.",
              kind: "invalid-output",
            }),
        ),
      );
    });
  return makePromptTextGeneration(run);
}
