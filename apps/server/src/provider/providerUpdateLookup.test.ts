import { ProviderDriverKind } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { HttpClient, HttpClientError, HttpClientResponse } from "effect/unstable/http";

import {
  extractProviderVersion,
  compareProviderVersions,
  NPM_UPDATE_SOURCES,
  lookupLatestVersion,
  lookupNpmLatestVersion,
} from "./providerUpdateLookup.ts";

function sourceForCodex() {
  return { kind: "npm", pkg: "@openai/codex", tag: "latest" } as const;
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
      });
    }),
  );

  it("uses the verified OpenCode npm package name", () => {
    assert.strictEqual(NPM_UPDATE_SOURCES.opencode, "opencode-ai");
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

describe("source-specific lookups", () => {
  it.effect("requests the selected npm channel", () =>
    Effect.gen(function* () {
      const client = HttpClient.make((request) => {
        assert.strictEqual(
          request.url,
          "https://registry.npmjs.org/@anthropic-ai%2Fclaude-code/stable",
        );
        return Effect.succeed(
          HttpClientResponse.fromWeb(request, new Response('{"version":"1.2.3"}')),
        );
      });
      assert.deepStrictEqual(
        yield* lookupNpmLatestVersion({
          kind: "npm",
          pkg: "@anthropic-ai/claude-code",
          tag: "stable",
        }).pipe(Effect.provideService(HttpClient.HttpClient, client)),
        { _tag: "success", latestVersion: "1.2.3" },
      );
    }),
  );
  it.effect("reads cask versions with a comma suffix", () =>
    lookupLatestVersion({ kind: "brew-api-cask", token: "codex" }).pipe(
      Effect.provide(httpClientLayer(new Response('{"version":"1.2.3,123"}'))),
      Effect.map((result) =>
        assert.deepStrictEqual(result, { _tag: "success", latestVersion: "1.2.3" }),
      ),
    ),
  );
  it.effect("reads formula stable versions", () =>
    lookupLatestVersion({ kind: "brew-api-formula", name: "opencode" }).pipe(
      Effect.provide(httpClientLayer(new Response('{"versions":{"stable":"1.2.3"}}'))),
      Effect.map((result) =>
        assert.deepStrictEqual(result, { _tag: "success", latestVersion: "1.2.3" }),
      ),
    ),
  );
  it.effect("maps missing Homebrew versions", () =>
    lookupLatestVersion({ kind: "brew-api-formula", name: "missing" }).pipe(
      Effect.provide(httpClientLayer(new Response("missing", { status: 404 }))),
      Effect.map((result) =>
        assert.deepStrictEqual(result, { _tag: "failure", failure: { _tag: "not_found" } }),
      ),
    ),
  );
  for (const cask of [false, true])
    it.effect(`reads local tap ${cask ? "cask" : "formula"} without updating it`, () =>
      lookupLatestVersion(
        { kind: "brew-local", brewExecutable: "/brew", ref: "custom/tap/cli", cask },
        {
          runProcess: async (_command, args, options) => {
            assert.deepStrictEqual(args, [
              "info",
              "--json=v2",
              ...(cask ? ["--cask"] : []),
              "custom/tap/cli",
            ]);
            assert.strictEqual(options.env.HOMEBREW_NO_AUTO_UPDATE, "1");
            return {
              code: 0,
              signal: null,
              timedOut: false,
              stderr: "",
              stdout: JSON.stringify(
                cask
                  ? { casks: [{ version: "1.2.3,123" }] }
                  : { formulae: [{ versions: { stable: "1.2.3" } }] },
              ),
            };
          },
        },
      ).pipe(
        Effect.provide(httpClientLayer(new Response(""))),
        Effect.map((result) =>
          assert.deepStrictEqual(result, { _tag: "success", latestVersion: "1.2.3" }),
        ),
      ),
    );
  it.effect("maps a failing brew info to parse", () =>
    lookupLatestVersion(
      { kind: "brew-local", brewExecutable: "/brew", ref: "custom/tap/cli", cask: false },
      {
        runProcess: async () => ({
          code: 1,
          signal: null,
          timedOut: false,
          stdout: "{}",
          stderr: "failed",
        }),
      },
    ).pipe(
      Effect.provide(httpClientLayer(new Response(""))),
      Effect.map((result) => {
        assert.strictEqual(result._tag, "failure");
        if (result._tag === "failure") assert.strictEqual(result.failure._tag, "parse");
      }),
    ),
  );
  it("extracts prefixed probe versions and orders prereleases", () => {
    assert.strictEqual(
      extractProviderVersion(ProviderDriverKind.make("codex"), "codex-cli 1.2.3-beta.2"),
      "1.2.3-beta.2",
    );
    assert.strictEqual(
      extractProviderVersion(ProviderDriverKind.make("claudeAgent"), "2.3.4 (Claude Code)"),
      "2.3.4",
    );
    assert.ok(compareProviderVersions("1.2.3", "1.2.3-beta.2") > 0);
    assert.ok(compareProviderVersions("1.2.3-beta.10", "1.2.3-beta.2") > 0);
  });
});

it("preserves the complete prerelease suffix without changing generic health-probe parsing", () => {
  for (const driver of ["codex", "claudeAgent", "opencode"]) {
    assert.strictEqual(
      extractProviderVersion(ProviderDriverKind.make(driver), "CLI 1.0.0-beta-2"),
      "1.0.0-beta-2",
    );
    assert.strictEqual(
      extractProviderVersion(ProviderDriverKind.make(driver), "CLI v1.2-beta-2.10"),
      "1.2.0-beta-2.10",
    );
  }
  assert.ok(compareProviderVersions("1.0.0-beta-2", "1.0.0-beta-1") > 0);
});
