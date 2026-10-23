import { ProviderDriverKind, type ServerProviderVersionAdvisory } from "@t3tools/contracts";
import { compareCliReleaseVersions, versionToken } from "@t3tools/shared/cliRelease";
import { Data, Duration, Effect, Option, Result, Schema } from "effect";
import { Headers, HttpClient, HttpClientRequest } from "effect/unstable/http";
import type { ProviderLatestSource } from "./providerInstallChannel.ts";
import { runProcess, type ProcessRunOptions, type ProcessRunResult } from "../processRunner.ts";

class InvalidProviderReleaseMetadata extends Data.TaggedError("InvalidProviderReleaseMetadata")<{
  readonly cause: unknown;
}> {}

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
    }
  | {
      readonly _tag: "failure";
      readonly failure: LatestVersionLookupFailure;
    };

export { NPM_UPDATE_SOURCES } from "./providerInstallChannel.ts";

export const isBuiltInProviderDriver = (driver: ProviderDriverKind): boolean =>
  driver === "codex" ||
  driver === "claudeAgent" ||
  driver === "cursor" ||
  driver === "opencode" ||
  driver === "pi";

export function extractProviderVersion(
  _driver: ProviderDriverKind,
  output: string | null,
): string | null {
  if (!output) return null;
  const parsed = output.match(/\bv?(\d+\.\d+(?:\.\d+)?(?:-[0-9A-Za-z.-]+)?)\b/)?.[1];
  if (!parsed) return null;
  try {
    const [core, ...suffix] = parsed.split("-");
    const normalizedCore = core!.split(".").length === 2 ? `${core}.0` : core!;
    return versionToken(normalizedCore + (suffix.length ? `-${suffix.join("-")}` : ""));
  } catch {
    return null;
  }
}
export const compareProviderVersions = compareCliReleaseVersions;

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

function rateLimitedFailure(retryAfterMs: number | undefined): LatestVersionLookupResult {
  const failure: LatestVersionLookupFailure =
    retryAfterMs === undefined ? { _tag: "rate_limited" } : { _tag: "rate_limited", retryAfterMs };
  return { _tag: "failure", failure };
}

export const lookupNpmLatestVersion = (
  source: Extract<ProviderLatestSource, { kind: "npm" }>,
): Effect.Effect<LatestVersionLookupResult, never, HttpClient.HttpClient> =>
  lookupHttpVersion(
    `https://registry.npmjs.org/${encodeURIComponent(source.pkg).replace("%40", "@")}/${source.tag}`,
    (value) => Schema.decodeUnknownSync(NpmLatestSchema)(value).version,
  );

const lookupHttpVersion = (
  url: string,
  parse: (value: unknown) => string,
): Effect.Effect<LatestVersionLookupResult, never, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const httpClient = yield* HttpClient.HttpClient;
    const request = HttpClientRequest.get(url, { acceptJson: true });
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

    const parsed = yield* response.json.pipe(
      Effect.flatMap((value) =>
        Effect.try({
          try: () => versionToken(parse(value)),
          catch: (cause) => new InvalidProviderReleaseMetadata({ cause }),
        }),
      ),
      Effect.result,
    );
    if (Result.isFailure(parsed))
      return {
        _tag: "failure",
        failure: { _tag: "parse", cause: parsed.failure },
      } satisfies LatestVersionLookupResult;
    return { _tag: "success", latestVersion: parsed.success } satisfies LatestVersionLookupResult;
  }).pipe(
    Effect.timeoutOption(LOOKUP_TIMEOUT),
    Effect.map((result) =>
      Option.isSome(result)
        ? result.value
        : ({ _tag: "failure", failure: { _tag: "network", cause: "timeout" } } as const),
    ),
  );

export type ProviderUpdateProcessRunner = (
  command: string,
  args: readonly string[],
  options: ProcessRunOptions,
) => Promise<ProcessRunResult>;

export const lookupLatestVersion = (
  source: ProviderLatestSource,
  options: {
    readonly runProcess?: ProviderUpdateProcessRunner;
    readonly environment?: NodeJS.ProcessEnv;
    readonly cwd?: string;
  } = {},
): Effect.Effect<LatestVersionLookupResult, never, HttpClient.HttpClient> => {
  if (source.kind === "npm") return lookupNpmLatestVersion(source);
  if (source.kind === "brew-local")
    return Effect.tryPromise(async () => {
      const result = await (options.runProcess ?? runProcess)(
        source.brewExecutable,
        ["info", "--json=v2", ...(source.cask ? ["--cask"] : []), source.ref],
        {
          env: { ...options.environment, HOMEBREW_NO_AUTO_UPDATE: "1" },
          cwd: options.cwd,
          timeoutMs: 30_000,
          allowNonZeroExit: true,
          maxBufferBytes: 1024 * 1024,
        },
      );
      if (result.code !== 0 || result.timedOut) throw new Error("brew info failed");
      const value = JSON.parse(result.stdout);
      const version = source.cask
        ? value.casks?.[0]?.version?.split(",")[0]
        : value.formulae?.[0]?.versions?.stable;
      return {
        _tag: "success",
        latestVersion: versionToken(version),
      } satisfies LatestVersionLookupResult;
    }).pipe(
      Effect.catch((cause) =>
        Effect.succeed({ _tag: "failure", failure: { _tag: "parse", cause } } as const),
      ),
    );
  const cask = source.kind === "brew-api-cask";
  const name = source.kind === "brew-api-cask" ? source.token : source.name;
  return lookupHttpVersion(
    `https://formulae.brew.sh/api/${cask ? "cask" : "formula"}/${encodeURIComponent(name)}.json`,
    (value) => {
      const data = value as { version?: string; versions?: { stable?: string } };
      const version = cask ? data.version?.split(",")[0] : data.versions?.stable;
      return versionToken(version);
    },
  );
};
