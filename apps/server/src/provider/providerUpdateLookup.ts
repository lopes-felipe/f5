import {
  ProviderDriverKind,
  type ServerProviderUpdateCommand,
  type ServerProviderVersionAdvisory,
} from "@t3tools/contracts";
import { Duration, Effect, Option, Result, Schema } from "effect";
import {
  Headers,
  HttpClient,
  HttpClientRequest,
  type HttpClientResponse,
} from "effect/unstable/http";

const LOOKUP_TIMEOUT = Duration.seconds(5);

const NpmLatestSchema = Schema.Struct({
  version: Schema.String,
});

export type LatestVersionLookupFailure =
  | { readonly _tag: "network"; readonly cause: unknown }
  | { readonly _tag: "rate_limited"; readonly retryAfterMs?: number }
  | { readonly _tag: "not_found" }
  | { readonly _tag: "parse"; readonly cause: unknown };

export type LatestVersionLookupResult =
  | {
      readonly _tag: "success";
      readonly latestVersion: string;
      readonly updateCommand: ServerProviderUpdateCommand;
    }
  | {
      readonly _tag: "failure";
      readonly failure: LatestVersionLookupFailure;
    };

interface NpmProviderUpdateSource {
  readonly packageName: string;
  readonly registryUrl: string;
  readonly updateCommand: ServerProviderUpdateCommand;
}

const makeNpmUpdateSource = (packageName: string): NpmProviderUpdateSource => ({
  packageName,
  registryUrl: `https://registry.npmjs.org/${encodeURIComponent(packageName).replace(
    "%40",
    "@",
  )}/latest`,
  updateCommand: {
    executable: "npm",
    args: ["install", "-g", `${packageName}@latest`],
    channel: "npm",
  },
});

const NPM_UPDATE_SOURCES = new Map<string, NpmProviderUpdateSource>([
  ["codex", makeNpmUpdateSource("@openai/codex")],
  ["claudeAgent", makeNpmUpdateSource("@anthropic-ai/claude-code")],
  // Verified 2026-05-26:
  // - `npm view opencode-ai version --json` resolves.
  // - `npm view @opencode-ai/opencode version --json` and `npm view opencode version --json` 404.
  ["opencode", makeNpmUpdateSource("opencode-ai")],
]);

export const isBuiltInProviderDriver = (driver: ProviderDriverKind): boolean =>
  driver === "codex" || driver === "claudeAgent" || driver === "cursor" || driver === "opencode";

export const getProviderUpdateSource = (
  driver: ProviderDriverKind,
): NpmProviderUpdateSource | null => NPM_UPDATE_SOURCES.get(driver) ?? null;

export const makeUnknownProviderVersionAdvisory = (input: {
  readonly currentVersion: string | null;
  readonly checkedAt?: string | null;
  readonly message?: string | null;
}): ServerProviderVersionAdvisory => ({
  status: "unknown",
  currentVersion: input.currentVersion,
  latestVersion: null,
  updateCommand: null,
  checkedAt: input.checkedAt ?? null,
  message: input.message ?? null,
});

function parseRetryAfterMs(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const asSeconds = Number(value);
  if (Number.isFinite(asSeconds) && asSeconds >= 0) {
    return Math.round(asSeconds * 1000);
  }
  const asDateMs = Date.parse(value);
  if (!Number.isFinite(asDateMs)) return undefined;
  return Math.max(0, asDateMs - Date.now());
}

function decodeNpmLatest(response: HttpClientResponse.HttpClientResponse) {
  return response.json.pipe(Effect.flatMap(Schema.decodeUnknownEffect(NpmLatestSchema)));
}

function rateLimitedFailure(retryAfterMs: number | undefined): LatestVersionLookupResult {
  const failure: LatestVersionLookupFailure =
    retryAfterMs === undefined ? { _tag: "rate_limited" } : { _tag: "rate_limited", retryAfterMs };
  return { _tag: "failure", failure };
}

export const lookupNpmLatestVersion = (
  source: NpmProviderUpdateSource,
): Effect.Effect<LatestVersionLookupResult, never, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const httpClient = yield* HttpClient.HttpClient;
    const request = HttpClientRequest.get(source.registryUrl, { acceptJson: true });
    const responseResult = yield* httpClient
      .execute(request)
      .pipe(Effect.timeoutOption(LOOKUP_TIMEOUT), Effect.result);

    if (Result.isFailure(responseResult)) {
      return {
        _tag: "failure",
        failure: { _tag: "network", cause: responseResult.failure },
      } satisfies LatestVersionLookupResult;
    }

    if (Option.isNone(responseResult.success)) {
      return {
        _tag: "failure",
        failure: { _tag: "network", cause: "timeout" },
      } satisfies LatestVersionLookupResult;
    }

    const response = responseResult.success.value;
    if (response.status === 429) {
      return rateLimitedFailure(parseRetryAfterMs(Headers.get(response.headers, "retry-after")));
    }

    if (response.status === 404 || (response.status >= 400 && response.status < 500)) {
      return {
        _tag: "failure",
        failure: { _tag: "not_found" },
      } satisfies LatestVersionLookupResult;
    }

    if (response.status >= 500) {
      return {
        _tag: "failure",
        failure: { _tag: "network", cause: `HTTP ${response.status}` },
      } satisfies LatestVersionLookupResult;
    }

    if (response.status < 200 || response.status >= 300) {
      return {
        _tag: "failure",
        failure: { _tag: "network", cause: `HTTP ${response.status}` },
      } satisfies LatestVersionLookupResult;
    }

    const parsed = yield* decodeNpmLatest(response).pipe(Effect.result);
    if (Result.isFailure(parsed)) {
      return {
        _tag: "failure",
        failure: { _tag: "parse", cause: parsed.failure },
      } satisfies LatestVersionLookupResult;
    }

    return {
      _tag: "success",
      latestVersion: parsed.success.version,
      updateCommand: source.updateCommand,
    } satisfies LatestVersionLookupResult;
  });

export const lookupLatestVersionForDriver = (
  driver: ProviderDriverKind,
): Effect.Effect<LatestVersionLookupResult | null, never, HttpClient.HttpClient> => {
  const source = getProviderUpdateSource(driver);
  if (!source) return Effect.succeed(null);
  return lookupNpmLatestVersion(source);
};
