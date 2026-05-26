import { ProviderDriverKind } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { HttpClient, HttpClientError, HttpClientResponse } from "effect/unstable/http";

import { getProviderUpdateSource, lookupNpmLatestVersion } from "./providerUpdateLookup.ts";

function sourceForCodex() {
  const source = getProviderUpdateSource(ProviderDriverKind.make("codex"));
  assert.ok(source);
  return source;
}

function httpClientLayer(response: Response) {
  const client = HttpClient.make((request) =>
    Effect.succeed(HttpClientResponse.fromWeb(request, response)),
  );
  return Layer.succeed(HttpClient.HttpClient, client);
}

function failingHttpClientLayer(cause: unknown) {
  const client = HttpClient.make(() => Effect.fail(cause as HttpClientError.HttpClientError));
  return Layer.succeed(HttpClient.HttpClient, client);
}

describe("provider update lookup", () => {
  it.effect("reads the latest npm version from a 200 response", () =>
    Effect.gen(function* () {
      const result = yield* lookupNpmLatestVersion(sourceForCodex()).pipe(
        Effect.provide(httpClientLayer(new Response(JSON.stringify({ version: "1.2.3" })))),
      );

      assert.deepStrictEqual(result, {
        _tag: "success",
        latestVersion: "1.2.3",
        updateCommand: {
          executable: "npm",
          args: ["install", "-g", "@openai/codex@latest"],
          channel: "npm",
        },
      });
    }),
  );

  it("uses the verified OpenCode npm package name", () => {
    const source = getProviderUpdateSource(ProviderDriverKind.make("opencode"));

    assert.strictEqual(source?.packageName, "opencode-ai");
    assert.deepStrictEqual(source?.updateCommand.args, ["install", "-g", "opencode-ai@latest"]);
  });

  it.effect("maps malformed 200 responses to parse failures", () =>
    Effect.gen(function* () {
      const result = yield* lookupNpmLatestVersion(sourceForCodex()).pipe(
        Effect.provide(httpClientLayer(new Response(JSON.stringify({ name: "@openai/codex" })))),
      );

      assert.strictEqual(result._tag, "failure");
      if (result._tag === "failure") {
        assert.strictEqual(result.failure._tag, "parse");
      }
    }),
  );

  it.effect("maps 404 responses to not_found failures", () =>
    Effect.gen(function* () {
      const result = yield* lookupNpmLatestVersion(sourceForCodex()).pipe(
        Effect.provide(httpClientLayer(new Response("missing", { status: 404 }))),
      );

      assert.strictEqual(result._tag, "failure");
      if (result._tag === "failure") {
        assert.strictEqual(result.failure._tag, "not_found");
      }
    }),
  );

  it.effect("maps 429 responses to rate_limited failures with retry-after", () =>
    Effect.gen(function* () {
      const result = yield* lookupNpmLatestVersion(sourceForCodex()).pipe(
        Effect.provide(
          httpClientLayer(
            new Response("slow down", { status: 429, headers: { "Retry-After": "2" } }),
          ),
        ),
      );

      assert.strictEqual(result._tag, "failure");
      if (result._tag === "failure") {
        assert.strictEqual(result.failure._tag, "rate_limited");
        if (result.failure._tag === "rate_limited") {
          assert.strictEqual(result.failure.retryAfterMs, 2000);
        }
      }
    }),
  );

  it.effect("maps 429 Retry-After HTTP dates to retry delays", () =>
    Effect.gen(function* () {
      const retryAt = new Date(Date.now() + 60_000).toUTCString();
      const result = yield* lookupNpmLatestVersion(sourceForCodex()).pipe(
        Effect.provide(
          httpClientLayer(
            new Response("slow down", { status: 429, headers: { "Retry-After": retryAt } }),
          ),
        ),
      );

      assert.strictEqual(result._tag, "failure");
      if (result._tag === "failure") {
        assert.strictEqual(result.failure._tag, "rate_limited");
        if (result.failure._tag === "rate_limited") {
          assert.ok((result.failure.retryAfterMs ?? 0) > 0);
          assert.ok((result.failure.retryAfterMs ?? 0) <= 60_000);
        }
      }
    }),
  );

  it.effect("maps 5xx responses to network failures", () =>
    Effect.gen(function* () {
      const result = yield* lookupNpmLatestVersion(sourceForCodex()).pipe(
        Effect.provide(httpClientLayer(new Response("server error", { status: 503 }))),
      );

      assert.strictEqual(result._tag, "failure");
      if (result._tag === "failure") {
        assert.strictEqual(result.failure._tag, "network");
      }
    }),
  );

  it.effect("maps client failures to network failures", () =>
    Effect.gen(function* () {
      const result = yield* lookupNpmLatestVersion(sourceForCodex()).pipe(
        Effect.provide(failingHttpClientLayer(new Error("offline"))),
      );

      assert.strictEqual(result._tag, "failure");
      if (result._tag === "failure") {
        assert.strictEqual(result.failure._tag, "network");
      }
    }),
  );
});
