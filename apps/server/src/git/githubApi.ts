import { normalizeGitHubCliError } from "./githubCliError.ts";
import { enforceGitHubRequestPolicy } from "./githubRequestPolicy.ts";
import {
  makeGitHubConditionalCache,
  type GitHubConditionalRead,
} from "./githubConditionalCache.ts";
import {
  githubRequestScheduler,
  GitHubSyncWait,
  type GitHubResource,
} from "./githubRequestScheduler.ts";
import { createHash, randomUUID } from "node:crypto";
import { Effect, Exit, Option, Semaphore, ServiceMap } from "effect";
import type { SourceControlRateLimit } from "@t3tools/contracts";

import { GitHubCliError } from "./Errors.ts";
import type { GitHubCliShape } from "./Services/GitHubCli.ts";

export interface GitHubCredentialContext {
  readonly host: string;
  readonly viewerId: number;
  readonly login: string;
  readonly generation: string;
}

/** Operation-local capture, inherited by every CLI call in the Effect. */
export class GitHubCredentialScope extends ServiceMap.Service<
  GitHubCredentialScope,
  GitHubCredentialContext
>()("t3/git/githubApi/GitHubCredentialScope") {}

export interface GitHubApiResponse {
  readonly status: number;
  readonly body: unknown;
  readonly graphqlErrors: readonly unknown[];
  readonly links: Readonly<Record<string, string>>;
  readonly etag: string | null;
  readonly lastModified: string | null;
  readonly rateLimit: SourceControlRateLimit;
  readonly rateLimitResource: string | null;
}

/** An older `gh` has no flag for printing terminal text, so it cannot return a job log. */
export const GITHUB_CLI_LOGS_UNSUPPORTED =
  "The installed GitHub CLI (`gh`) is too old to print job logs.";

/** Reported while a credential GitHub answered with 401 is suspended. */
export const GITHUB_CREDENTIAL_SUSPENDED =
  "GitHub rejected the credential. F5 will check it again shortly; reconnect in Settings > Integrations if this keeps happening.";
const CREDENTIAL_SUSPENSION_INITIAL_MS = 60_000;
const CREDENTIAL_SUSPENSION_MAX_MS = 15 * 60_000;

/**
 * One account verification can send two requests (/user, then the GraphQL viewer after a
 * 403). The first to probe a suspended credential records its claim here, so the fallback
 * probes under the same claim instead of being refused by it.
 */
interface SuspensionProbe {
  armed: number | null;
}

export interface GitHubApiRequest {
  readonly cwd: string;
  readonly context: GitHubCredentialContext;
  readonly method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  readonly endpoint: string;
  readonly body?: unknown;
  readonly accept?: "application/vnd.github.diff";
  /**
   * The response is terminal output, such as a job log: plain text that can hold escape
   * sequences. The CLI refuses to print those unless it is told to.
   */
  readonly terminalText?: boolean;
  readonly query?: Readonly<Record<string, string | number | boolean>>;
  readonly cache?: GitHubConditionalRead;
  readonly ifNoneMatch?: string | undefined;
  readonly ifModifiedSince?: string | undefined;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
}

const credentials = new WeakMap<GitHubCredentialContext, { token: string; fingerprint: string }>();
/**
 * Variables that can re-authenticate or retarget a `gh` invocation, so an inherited
 * value must never reach a credential-scoped call. Purely local configuration
 * (GH_CONFIG_DIR, GH_PAGER, GH_EDITOR, …) is deliberately preserved: stripping it
 * would break users who point `gh` at their own config.
 */
const OVERRIDDEN_VARIABLES = new Set([
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GH_ENTERPRISE_TOKEN",
  "GITHUB_ENTERPRISE_TOKEN",
  "GH_HOST",
  "GH_DEBUG",
  // Silently rewrites the target of `gh pr`/`gh repo` when no --repo is given.
  "GH_REPO",
]);

function normalizeHost(host: string): string {
  const normalized = host.trim().toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(normalized) || normalized.includes("..")) {
    throw new Error("Invalid GitHub hostname.");
  }
  return normalized;
}

export function isGitHubCloudHost(host: string): boolean {
  return host === "github.com" || host.endsWith(".ghe.com");
}

export function cleanGitHubEnvironment(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(process.env).filter(([key]) => {
      const name = key.toUpperCase();
      // The pattern also catches token variables this list has not learned about yet.
      return !OVERRIDDEN_VARIABLES.has(name) && !/^(?:GH|GITHUB)_.*TOKEN$/.test(name);
    }),
  );
}

function tokenEnvironment(host: string, token: string): NodeJS.ProcessEnv {
  return {
    ...cleanGitHubEnvironment(),
    GH_HOST: host,
    [isGitHubCloudHost(host) ? "GH_TOKEN" : "GH_ENTERPRISE_TOKEN"]: token,
  };
}

/** The token and its fingerprint are kept outside the serializable account identity. */
export function githubCredentialEnvironment(context: GitHubCredentialContext): NodeJS.ProcessEnv {
  const credential = credentials.get(context);
  if (!credential) throw new Error("Unverified GitHub credential context.");
  return tokenEnvironment(context.host, credential.token);
}

function isRateLimitedResponse(response: GitHubApiResponse): boolean {
  return (
    response.status === 429 ||
    (response.status === 403 &&
      (response.rateLimit.remaining === 0 || response.rateLimit.retryAfterSeconds != null)) ||
    response.graphqlErrors.some(
      (error) =>
        typeof error === "object" &&
        error !== null &&
        (error as { type?: unknown }).type === "RATE_LIMITED",
    )
  );
}

function nonNegativeHeader(headers: Map<string, string>, name: string): number | null {
  const value = headers.get(name);
  if (value === undefined || !/^\d+$/.test(value)) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : null;
}

class GitHubResponseParseError extends Error {
  constructor(
    readonly category:
      | "headers_missing_or_oversized"
      | "invalid_status"
      | "invalid_header"
      | "invalid_json",
    readonly status: number | null = null,
  ) {
    super(`Invalid GitHub response: ${category}.`);
  }
}

/** Parse exactly one --include response. Incomplete bodies are never empty successes. */
export function parseGitHubApiResponse(
  output: string,
  now = Date.now(),
  format: "json" | "text" = "json",
): GitHubApiResponse {
  const statusMatch = /^HTTP\/\S+\s+(\d{3})(?:\s|$)/.exec(output.slice(0, 256));
  const separator = /\r?\n\r?\n/.exec(output);
  if (!separator || separator.index > 64 * 1024)
    throw new GitHubResponseParseError(
      "headers_missing_or_oversized",
      statusMatch ? Number(statusMatch[1]) : null,
    );
  const lines = output.slice(0, separator.index).split(/\r?\n/);
  const match = /^HTTP\/\S+\s+(\d{3})(?:\s|$)/.exec(lines.shift() ?? "");
  if (!match) throw new GitHubResponseParseError("invalid_status");
  const status = Number(match[1]);
  const headers = new Map<string, string>();
  for (const line of lines) {
    const colon = line.indexOf(":");
    if (colon <= 0) throw new GitHubResponseParseError("invalid_header", status);
    const name = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    headers.set(name, headers.has(name) ? `${headers.get(name)}, ${value}` : value);
  }
  const rawBody = output.slice(separator.index + separator[0].length);
  let body: unknown = null;
  if (status !== 204 && status !== 304) {
    try {
      body = format === "text" && status < 400 ? rawBody : JSON.parse(rawBody);
    } catch {
      // Gateways can return text/HTML errors. Preserve their HTTP status and
      // retry headers so callers and the scheduler can handle the failure.
      if (status < 400 || status > 599) throw new GitHubResponseParseError("invalid_json", status);
    }
  }
  const root = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : null;
  const links: Record<string, string> = {};
  for (const link of (headers.get("link") ?? "").matchAll(/<([^>]+)>\s*;\s*rel="([^"]+)"/g)) {
    for (const relation of link[2]!.split(" ")) links[relation] = link[1]!;
  }
  const reset = nonNegativeHeader(headers, "x-ratelimit-reset");
  const retry = headers.get("retry-after");
  const retrySeconds =
    nonNegativeHeader(headers, "retry-after") ??
    (retry && Number.isFinite(Date.parse(retry))
      ? Math.max(0, Math.ceil((Date.parse(retry) - now) / 1000))
      : null);
  return {
    status,
    body,
    graphqlErrors: Array.isArray(root?.errors) ? root.errors : [],
    links,
    etag: headers.get("etag") ?? null,
    lastModified: headers.get("last-modified") ?? null,
    rateLimitResource: headers.get("x-ratelimit-resource") ?? null,
    rateLimit: {
      remaining: nonNegativeHeader(headers, "x-ratelimit-remaining"),
      limit: nonNegativeHeader(headers, "x-ratelimit-limit"),
      resetAt:
        reset !== null && Number.isFinite(new Date(reset * 1000).getTime())
          ? new Date(reset * 1000).toISOString()
          : null,
      retryAfterSeconds: retrySeconds,
    },
  };
}

/** The endpoint as sent to GitHub, or an error when it's malformed. Exported for tests. */
export function requestEndpoint(input: Pick<GitHubApiRequest, "endpoint" | "query">): string {
  const endpoint = input.endpoint.replace(/^\/(?!\/)/, "");
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_./%-]*$/.test(endpoint))
    throw new Error("Expected a relative GitHub API endpoint.");
  // A percent-encoded character (a space, `#` or `:` in a file name, `/` in a branch name)
  // stays encoded on the wire, so it can't change the request's structure. What is refused is
  // a decoded path that walks up, a backslash or control character, or a second layer of
  // encoding (`%252e`) that a later decode could turn into one.
  let decoded: string;
  try {
    decoded = decodeURIComponent(endpoint);
  } catch {
    throw new Error("Invalid GitHub API endpoint.");
  }
  if (
    decoded.split("/").some((part) => part === "." || part === "..") ||
    /[\\\u0000-\u001f\u007f]/.test(decoded) ||
    /%[0-9a-f]{2}/i.test(decoded)
  ) {
    throw new Error("Invalid GitHub API endpoint.");
  }
  const query = new URLSearchParams(
    Object.entries(input.query ?? {}).map(
      ([key, value]) => [key, String(value)] as [string, string],
    ),
  );
  return query.size > 0 ? `${endpoint}?${query}` : endpoint;
}

export function makeGitHubApi(
  execute: GitHubCliShape["execute"],
  scheduler = githubRequestScheduler,
  resolveToken: (
    host: string,
    cwd: string,
    bypassCliCache?: boolean,
  ) => Effect.Effect<string, GitHubCliError> = () => Effect.succeed(""),
  options: { readonly invalidateToken?: (host: string) => void } = {},
) {
  /**
   * Per host, a credential GitHub answered with 401. It is suspended until `retryAt`, then
   * one request (or verification) probes it: a 401 doubles the window, any other answer from
   * GitHub below 500 lifts it. A 401 can be transient, so the suspension must never be final.
   */
  const rejectedCredentials = new Map<
    string,
    { fingerprint: string; retryAt: number; backoffMs: number; armed: number }
  >();
  /**
   * Increases each time a suspension is armed or probed. A request remembers the value it
   * was admitted under: one admitted before the current arming answers for an earlier moment
   * (it was already queued or in flight), so its outcome neither extends nor lifts it.
   */
  let suspensionSequence = 0;
  const suspension = (host: string, fingerprint: string): "blocked" | "expired" | null => {
    const entry = rejectedCredentials.get(host);
    if (!entry || entry.fingerprint !== fingerprint) return null;
    return Date.now() < entry.retryAt ? "blocked" : "expired";
  };
  /**
   * Claims the single probe of an expired suspension and returns the claim; concurrent
   * callers stay blocked until the probe is answered or gives the claim back.
   */
  const claimProbe = (host: string, entry: { backoffMs: number }): number => {
    const armed = ++suspensionSequence;
    rejectedCredentials.set(host, {
      ...rejectedCredentials.get(host)!,
      retryAt: Date.now() + entry.backoffMs,
      armed,
    });
    return armed;
  };
  /**
   * A probe that ended without an HTTP answer (refused by policy, interrupted, timed out)
   * proved nothing, so the next caller may probe at once instead of waiting a full window.
   */
  const releaseProbe = (host: string, armed: number) => {
    const entry = rejectedCredentials.get(host);
    if (entry?.armed === armed) rejectedCredentials.set(host, { ...entry, retryAt: Date.now() });
  };
  /** Records a 401 and returns the new suspension window, or null for a stale answer. */
  const recordRejected = (host: string, fingerprint: string, admitted: number): number | null => {
    const entry = rejectedCredentials.get(host);
    const same = entry?.fingerprint === fingerprint;
    if (same && admitted < entry.armed) return null;
    const backoffMs = same
      ? Math.min(entry.backoffMs * 2, CREDENTIAL_SUSPENSION_MAX_MS)
      : CREDENTIAL_SUSPENSION_INITIAL_MS;
    rejectedCredentials.set(host, {
      fingerprint,
      retryAt: Date.now() + backoffMs,
      backoffMs,
      armed: ++suspensionSequence,
    });
    return backoffMs;
  };
  const recordAccepted = (host: string, fingerprint: string, admitted: number) => {
    const entry = rejectedCredentials.get(host);
    if (entry?.fingerprint === fingerprint && admitted >= entry.armed)
      rejectedCredentials.delete(host);
  };
  /** Per host, the fingerprint of a credential that verified through the GraphQL viewer. */
  const viewerOnlyCredentials = new Map<string, string>();
  const accounts = new Map<string, GitHubCredentialContext>();
  const verifiedAt = new Map<string, number>();
  const identityLock = Semaphore.makeUnsafe(1);
  const requestCaptured = (
    input: Omit<GitHubApiRequest, "context"> & {
      host: string;
      token: string;
      expectedGeneration?: string;
      /** Shared by one account verification's requests; see `SuspensionProbe`. */
      probe?: SuspensionProbe;
      /** A plain 403 decides nothing here: the GraphQL viewer fallback answers instead. */
      fallsBackOn403?: boolean;
    },
  ): Effect.Effect<GitHubApiResponse, GitHubCliError> =>
    Effect.suspend(() => {
      let dispatched = false;
      /** The suspension sequence this request was admitted under; see `suspensionSequence`. */
      let admitted = suspensionSequence;
      /** The probe claim this request carries, if it probes a suspended credential. */
      let probing: number | null = null;
      /** A job log answered by the storage GitHub redirected to, not by GitHub. */
      let answeredByStorage = false;
      return Effect.gen(function* () {
        const prepared = yield* Effect.try({
          try: () => {
            const host = normalizeHost(input.host);
            const endpoint = requestEndpoint(input);
            const body = input.body === undefined ? undefined : JSON.stringify(input.body);
            if (body !== undefined && Buffer.byteLength(body, "utf8") > 1024 * 1024)
              throw new Error("GitHub request exceeds the 1 MiB body limit.");
            if (input.method === "GET" && body !== undefined)
              throw new Error("GET requests must use query parameters.");
            const args = [
              "api",
              endpoint,
              "--hostname",
              host,
              "--method",
              input.method,
              "--include",
            ];
            for (const [name, value] of [
              ["If-None-Match", input.ifNoneMatch],
              ["If-Modified-Since", input.ifModifiedSince],
            ] as const) {
              if (value === undefined) continue;
              if (/[\r\n]/.test(value) || value.length > 4096)
                throw new Error("Invalid conditional request header.");
              args.push("--header", `${name}: ${value}`);
            }
            if (input.accept !== undefined) {
              if (input.accept !== "application/vnd.github.diff")
                throw new Error("Invalid GitHub response format.");
              args.push("--header", `Accept: ${input.accept}`);
            }
            if (input.terminalText) {
              if (input.method !== "GET") throw new Error("Invalid GitHub response format.");
              args.push("--allow-escape-sequences");
            }
            if (body !== undefined) args.push("--input", "-");
            const timeoutMs = input.timeoutMs ?? 45_000;
            const maxStdoutBytes = input.maxResponseBytes ?? 8 * 1024 * 1024;
            if (
              !Number.isSafeInteger(timeoutMs) ||
              timeoutMs <= 0 ||
              timeoutMs > 45_000 ||
              !Number.isSafeInteger(maxStdoutBytes) ||
              maxStdoutBytes <= 0 ||
              maxStdoutBytes > 8 * 1024 * 1024
            )
              throw new Error("Invalid GitHub request limits.");
            return { args, body, timeoutMs, maxStdoutBytes };
          },
          catch: (cause) =>
            new GitHubCliError({
              operation: "request",
              kind: "generic",
              detail: cause instanceof Error ? cause.message : "Invalid GitHub request.",
            }),
        });
        const document =
          typeof input.body === "object" &&
          input.body !== null &&
          "query" in input.body &&
          typeof input.body.query === "string"
            ? input.body.query
            : "";
        const resource: GitHubResource =
          input.endpoint.replace(/^\//, "") === "graphql"
            ? /(^|\n)\s*mutation\b/.test(document)
              ? "write"
              : /\bsearch\s*\(/.test(document)
                ? "search"
                : "graphql"
            : input.method !== "GET"
              ? "write"
              : input.endpoint.replace(/^\//, "").startsWith("search/")
                ? "search"
                : "rest";
        const isGraphql = input.endpoint.replace(/^\//, "") === "graphql";
        const searchPages = document.match(/\bsearch\s*\(/g)?.length ?? 1;
        const fingerprint = createHash("sha256").update(input.token).digest("hex");
        const perform = Effect.gen(function* () {
          // The write's account check runs first: when the suspension has expired, it is the
          // verification that probes the credential, and it lifts the suspension on success.
          if (resource === "write" && input.expectedGeneration) {
            const current = yield* getCredentialContext({ cwd: input.cwd, host: input.host });
            if (current.generation !== input.expectedGeneration)
              return yield* new GitHubCliError({
                operation: "request",
                kind: "forbidden",
                detail: "The GitHub account changed before the write. Nothing was sent.",
              });
          }
          // Checked here, after the scheduler admitted the request, so a suspension that began
          // while it was queued still applies and a probe is claimed only when it can be sent.
          const entry = rejectedCredentials.get(input.host);
          if (entry?.fingerprint === fingerprint) {
            if (input.probe?.armed === entry.armed) probing = entry.armed;
            else if (Date.now() < entry.retryAt)
              return yield* new GitHubCliError({
                operation: "request",
                kind: "unauthenticated",
                detail: GITHUB_CREDENTIAL_SUSPENDED,
              });
            else {
              probing = claimProbe(input.host, entry);
              if (input.probe) input.probe.armed = probing;
            }
          }
          admitted = suspensionSequence;
          const result = yield* enforceGitHubRequestPolicy(
            Effect.suspend(() => {
              dispatched = true;
              return execute({
                cwd: input.cwd,
                args: prepared.args,
                timeoutMs: prepared.timeoutMs,
                maxStdoutBytes: prepared.maxStdoutBytes,
                allowNonZeroExit: true,
                env: tokenEnvironment(input.host, input.token),
                ...(prepared.body === undefined ? {} : { stdin: prepared.body }),
                ...(input.signal ? { signal: input.signal } : {}),
              });
            }),
            resource === "write",
          );
          if (result.timedOut || result.aborted || result.stdoutTruncated || result.signal) {
            return yield* Effect.fail(
              new GitHubCliError({
                operation: "request",
                kind: result.timedOut ? "timeout" : "invalid_json",
                detail: "GitHub response was interrupted or truncated.",
              }),
            );
          }
          if (input.terminalText) {
            // GitHub marks every API response with a request id; the storage holding a job
            // log does not. `--include` prints the headers of the final response.
            const headerEnd = result.stdout.search(/\r?\n\r?\n/);
            answeredByStorage = !/^x-github-request-id:/im.test(
              result.stdout.slice(0, headerEnd < 0 ? 0 : headerEnd),
            );
          }
          return yield* Effect.try({
            try: () =>
              parseGitHubApiResponse(
                result.stdout,
                Date.now(),
                input.accept || input.terminalText ? "text" : "json",
              ),
            catch: (cause) =>
              cause instanceof GitHubResponseParseError
                ? cause
                : new GitHubResponseParseError("invalid_json"),
          }).pipe(
            Effect.catch((error) =>
              Effect.gen(function* () {
                yield* Effect.logWarning("GitHub API response could not be parsed", {
                  endpoint: input.endpoint,
                  exitCode: result.code,
                  stdoutBytes: Buffer.byteLength(result.stdout, "utf8"),
                  stderrBytes: Buffer.byteLength(result.stderr, "utf8"),
                  status: error.status,
                  category: error.category,
                });
                if (
                  result.code !== 0 &&
                  input.terminalText &&
                  result.stderr.includes("unknown flag: --allow-escape-sequences")
                )
                  return yield* new GitHubCliError({
                    operation: "request",
                    kind: "generic",
                    detail: GITHUB_CLI_LOGS_UNSUPPORTED,
                  });
                if (result.code !== 0) {
                  const normalized = normalizeGitHubCliError(
                    "request",
                    new Error(result.stderr.trim() || "GitHub CLI command failed."),
                  );
                  // Do not retain raw stderr as a cause: it may contain request
                  // data. The shared normalizer supplies safe, fixed messages.
                  return yield* new GitHubCliError({
                    operation: "request",
                    kind: normalized.kind,
                    detail: normalized.detail,
                  });
                }
                return yield* new GitHubCliError({
                  operation: "request",
                  kind: "invalid_json",
                  detail: "GitHub returned an incomplete or invalid HTTP response.",
                });
              }),
            ),
          );
        });
        const recorded = perform.pipe(
          Effect.onExit((exit) =>
            Effect.sync(() => {
              if (probing !== null && Exit.isFailure(exit)) releaseProbe(input.host, probing);
            }),
          ),
          Effect.tap((response) =>
            Effect.gen(function* () {
              if (answeredByStorage) {
                // GitHub redirected to the storage, so it authenticated the credential;
                // whatever the storage answers says nothing about the GitHub token.
                recordAccepted(input.host, fingerprint, admitted);
              } else if (response.status === 401) {
                const backoffMs = recordRejected(input.host, fingerprint, admitted);
                if (backoffMs !== null)
                  yield* Effect.logWarning("GitHub rejected the credential; suspending it", {
                    host: input.host,
                    method: input.method,
                    endpoint: input.endpoint,
                    resource,
                    backoffMs,
                  });
              } else if (
                response.status < 500 &&
                !(input.fallsBackOn403 && response.status === 403)
              ) {
                // Any other answer below 500, including 403 and 404, means GitHub
                // authenticated the credential. A 5xx proves nothing either way.
                recordAccepted(input.host, fingerprint, admitted);
              }
              const body = response.body as { data?: { rateLimit?: { cost?: number } } } | null;
              scheduler.record(
                input.host,
                resource,
                response,
                body?.data?.rateLimit?.cost ?? 1,
                isGraphql,
              );
            }),
          ),
          Effect.tapError((error) =>
            Effect.sync(() => {
              if (error.kind === "network" || error.kind === "timeout")
                scheduler.networkFailure(input.host);
            }),
          ),
        );
        const run = scheduler.run(input.host, resource, recorded, {
          searchPages,
          graphql: isGraphql,
        });
        const response = yield* run;
        const sync = Option.getOrElse(yield* Effect.serviceOption(GitHubSyncWait), () => false);
        if (
          sync &&
          resource !== "write" &&
          (response.status === 429 ||
            (response.status === 403 &&
              (response.rateLimit.remaining === 0 || response.rateLimit.retryAfterSeconds != null)))
        ) {
          // Re-admission waits for the recorded reset. Retry a read at most once;
          // dispatched writes retain their original durable outcome.
          return yield* run;
        }
        return response;
      }).pipe(
        Effect.mapError(
          (error) =>
            new GitHubCliError({
              ...error,
              requestDispatched: dispatched && error.kind !== "binary_missing",
            }),
        ),
      );
    });

  const conditionalCache = makeGitHubConditionalCache();
  const requestUncached = (
    input: GitHubApiRequest,
  ): Effect.Effect<GitHubApiResponse, GitHubCliError> =>
    Effect.suspend(() => {
      const credential = credentials.get(input.context);
      if (!credential)
        return Effect.fail(
          new GitHubCliError({
            operation: "request",
            kind: "unauthenticated",
            detail: "Unverified GitHub credential context.",
            requestDispatched: false,
          }),
        );
      return Effect.gen(function* () {
        const perform = () =>
          requestCaptured({
            ...input,
            host: input.context.host,
            token: credential.token,
            expectedGeneration: input.context.generation,
          });
        const response = yield* perform();
        if (response.status !== 401) return response;
        // A 401 is safe to retry once, but never redirect an operation to another account.
        options.invalidateToken?.(input.context.host);
        const replacement = (yield* resolveToken(input.context.host, input.cwd)).trim();
        if (!replacement || replacement === credential.token) return response;
        const refreshed = yield* getCredentialContext({ cwd: input.cwd, host: input.context.host });
        const refreshedCredential = credentials.get(refreshed);
        if (!refreshedCredential || refreshed.viewerId !== input.context.viewerId)
          return yield* new GitHubCliError({
            operation: "request",
            kind: "forbidden",
            detail: "The GitHub account changed during credential refresh. Nothing was retried.",
          });
        return yield* requestCaptured({
          ...input,
          host: refreshed.host,
          token: refreshedCredential.token,
          expectedGeneration: refreshed.generation,
        });
      });
    });

  const request = (input: GitHubApiRequest) => conditionalCache(input, requestUncached);

  const getCredentialContext = (input: {
    cwd: string;
    host: string;
    cacheOnly?: boolean;
  }): Effect.Effect<GitHubCredentialContext, GitHubCliError> =>
    Effect.gen(function* () {
      const host = yield* Effect.try({
        try: () => normalizeHost(input.host),
        catch: () =>
          new GitHubCliError({
            operation: "credentials",
            kind: "generic",
            detail: "Invalid GitHub hostname.",
          }),
      });
      const token = (yield* resolveToken(host, input.cwd, input.cacheOnly)).trim();
      if (!token || /[\r\n]/.test(token))
        return yield* Effect.fail(
          new GitHubCliError({
            operation: "credentials",
            kind: "unauthenticated",
            detail: `GitHub is not connected for ${host}. Connect it in Settings > Integrations.`,
          }),
        );
      const fingerprint = createHash("sha256").update(token).digest("hex");
      const suspended = suspension(host, fingerprint);
      // A suspension whose window has passed is lifted only by verifying the credential
      // again, so an expired one bypasses the cached identity and its verification probes
      // (the probe is claimed when the scheduler admits the request; see `requestCaptured`).
      if (suspended === "blocked" || (suspended === "expired" && input.cacheOnly))
        return yield* new GitHubCliError({
          operation: "credentials",
          kind: "unauthenticated",
          detail: GITHUB_CREDENTIAL_SUSPENDED,
        });
      const probe: SuspensionProbe = { armed: null };
      // Always resolve the current token, including before writes, but a matching
      // credential need not spend another REST request proving the same identity.
      const cached = accounts.get(host);
      if (
        suspended === null &&
        cached &&
        credentials.get(cached)?.fingerprint === fingerprint &&
        Date.now() - (verifiedAt.get(host) ?? 0) < 60_000
      )
        return cached;
      if (input.cacheOnly)
        return yield* new GitHubCliError({
          operation: "credentials",
          kind: "unauthenticated",
          detail: "No recently verified GitHub identity for the current credential.",
        });
      // Some credentials (GitHub App and restricted tokens) cannot read /user but can still
      // read pull requests, so a plain 403 verifies the same token through the GraphQL viewer.
      // Its failures are this verification's failures, never a raw request error.
      const readViewer = requestCaptured({
        cwd: input.cwd,
        host,
        token,
        probe,
        method: "POST",
        endpoint: "graphql",
        body: { query: "query { viewer { databaseId login } }" },
      }).pipe(
        Effect.mapError(
          (error) =>
            new GitHubCliError({
              operation: "credentials",
              detail: error.detail,
              ...(error.kind === undefined ? {} : { kind: error.kind }),
              ...(error.rateLimit === undefined ? {} : { rateLimit: error.rateLimit }),
            }),
        ),
      );
      // A credential already known to need the viewer skips the /user read GitHub refuses.
      let viaViewer = viewerOnlyCredentials.get(host) === fingerprint;
      let verified = viaViewer
        ? yield* readViewer
        : yield* requestCaptured({
            cwd: input.cwd,
            host,
            token,
            probe,
            fallsBackOn403: true,
            method: "GET",
            endpoint: "user",
          });
      if (!viaViewer && verified.status === 403 && !isRateLimitedResponse(verified)) {
        verified = yield* readViewer;
        viaViewer = true;
      }
      const viewerNode = viaViewer
        ? (verified.body as { data?: { viewer?: Record<string, unknown> } } | null)?.data?.viewer
        : undefined;
      // The decisive response (REST, or the GraphQL fallback) classifies a failure.
      const rateLimited = isRateLimitedResponse(verified);
      const viewer = !viaViewer
        ? typeof verified.body === "object" && verified.body !== null
          ? (verified.body as Record<string, unknown>)
          : null
        : verified.graphqlErrors.length === 0 && viewerNode
          ? { id: viewerNode.databaseId, login: viewerNode.login }
          : null;
      // The verification requests themselves suspend a 401 credential and lift the
      // suspension on success; see the response tap in `requestCaptured`. A 401 reports the
      // suspension it caused, so it reads the same as the requests refused after it.
      if (verified.status !== 200 || rateLimited) {
        return yield* Effect.fail(
          new GitHubCliError({
            operation: "credentials",
            kind: rateLimited
              ? "rate_limited"
              : verified.status === 401
                ? "unauthenticated"
                : verified.status === 403
                  ? "forbidden"
                  : verified.status >= 500
                    ? "network"
                    : "generic",
            detail: rateLimited
              ? "GitHub temporarily limited account verification requests."
              : verified.status === 401
                ? GITHUB_CREDENTIAL_SUSPENDED
                : "GitHub account verification failed.",
            rateLimit: verified.rateLimit,
          }),
        );
      }
      if (
        typeof viewer?.id !== "number" ||
        !Number.isSafeInteger(viewer.id) ||
        viewer.id <= 0 ||
        typeof viewer.login !== "string" ||
        !viewer.login.trim()
      ) {
        return yield* Effect.fail(
          new GitHubCliError({
            operation: "credentials",
            kind: "invalid_json",
            detail: "GitHub could not verify the captured credential.",
            rateLimit: verified.rateLimit,
          }),
        );
      }
      if (viaViewer) viewerOnlyCredentials.set(host, fingerprint);
      else viewerOnlyCredentials.delete(host);
      const previous = accounts.get(host);
      const generation =
        previous?.viewerId === viewer.id && credentials.get(previous)?.fingerprint === fingerprint
          ? previous.generation
          : randomUUID();
      const context = Object.freeze({ host, viewerId: viewer.id, login: viewer.login, generation });
      credentials.set(context, { token, fingerprint });
      accounts.set(host, context);
      verifiedAt.set(host, Date.now());
      return context;
    });
  return {
    request,
    getCredentialContext: (input: Parameters<typeof getCredentialContext>[0]) =>
      identityLock.withPermits(1)(getCredentialContext(input)),
  };
}
