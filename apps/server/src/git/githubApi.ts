import { githubRequestScheduler, type GitHubResource } from "./githubRequestScheduler.ts";
import { createHash, randomUUID } from "node:crypto";
import { Effect, Semaphore, ServiceMap } from "effect";
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

export interface GitHubApiRequest {
  readonly cwd: string;
  readonly context: GitHubCredentialContext;
  readonly method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  readonly endpoint: string;
  readonly body?: unknown;
  readonly query?: Readonly<Record<string, string | number | boolean>>;
  readonly ifNoneMatch?: string;
  readonly ifModifiedSince?: string;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
}

const credentials = new WeakMap<GitHubCredentialContext, { token: string; fingerprint: string }>();
const TOKEN_VARIABLES = new Set([
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GH_ENTERPRISE_TOKEN",
  "GITHUB_ENTERPRISE_TOKEN",
]);

function normalizeHost(host: string): string {
  const normalized = host.trim().toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(normalized) || normalized.includes("..")) {
    throw new Error("Invalid GitHub hostname.");
  }
  return normalized;
}

function isCloudHost(host: string): boolean {
  return host === "github.com" || host.endsWith(".ghe.com");
}

function cleanEnvironment(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) =>
        !TOKEN_VARIABLES.has(key.toUpperCase()) &&
        !["GH_HOST", "GH_DEBUG"].includes(key.toUpperCase()),
    ),
  );
}

function tokenEnvironment(host: string, token: string): NodeJS.ProcessEnv {
  return {
    ...cleanEnvironment(),
    GH_HOST: host,
    [isCloudHost(host) ? "GH_TOKEN" : "GH_ENTERPRISE_TOKEN"]: token,
  };
}

/** The token and its fingerprint are kept outside the serializable account identity. */
export function githubCredentialEnvironment(context: GitHubCredentialContext): NodeJS.ProcessEnv {
  const credential = credentials.get(context);
  if (!credential) throw new Error("Unverified GitHub credential context.");
  return tokenEnvironment(context.host, credential.token);
}

function nonNegativeHeader(headers: Map<string, string>, name: string): number | null {
  const value = headers.get(name);
  if (value === undefined || !/^\d+$/.test(value)) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : null;
}

/** Parse exactly one --include response. Incomplete bodies are never empty successes. */
export function parseGitHubApiResponse(output: string, now = Date.now()): GitHubApiResponse {
  const separator = /\r?\n\r?\n/.exec(output);
  if (!separator || separator.index > 64 * 1024)
    throw new Error("Missing or oversized GitHub response headers.");
  const lines = output.slice(0, separator.index).split(/\r?\n/);
  const match = /^HTTP\/\S+\s+(\d{3})(?:\s|$)/.exec(lines.shift() ?? "");
  if (!match) throw new Error("Invalid GitHub response status.");
  const status = Number(match[1]);
  const headers = new Map<string, string>();
  for (const line of lines) {
    const colon = line.indexOf(":");
    if (colon <= 0) throw new Error("Invalid GitHub response header.");
    const name = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    headers.set(name, headers.has(name) ? `${headers.get(name)}, ${value}` : value);
  }
  const rawBody = output.slice(separator.index + separator[0].length).trim();
  const body: unknown = status === 204 || status === 304 ? null : JSON.parse(rawBody);
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

function requestEndpoint(input: Pick<GitHubApiRequest, "endpoint" | "query">): string {
  const endpoint = input.endpoint.replace(/^\/(?!\/)/, "");
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_./%-]*$/.test(endpoint))
    throw new Error("Expected a relative GitHub API endpoint.");
  const decoded = decodeURIComponent(endpoint);
  if (
    decoded.split("/").some((part) => part === "." || part === "..") ||
    /[\\\s?#{}:%]/.test(decoded)
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
) {
  const rejectedCredentials = new Map<string, string>();
  const accounts = new Map<string, GitHubCredentialContext>();
  const identityLock = Semaphore.makeUnsafe(1);
  const requestCaptured = (
    input: Omit<GitHubApiRequest, "context"> & {
      host: string;
      token: string;
      expectedGeneration?: string;
    },
  ): Effect.Effect<GitHubApiResponse, GitHubCliError> =>
    Effect.gen(function* () {
      const prepared = yield* Effect.try({
        try: () => {
          const host = normalizeHost(input.host);
          const endpoint = requestEndpoint(input);
          const body = input.body === undefined ? undefined : JSON.stringify(input.body);
          if (body !== undefined && Buffer.byteLength(body, "utf8") > 1024 * 1024)
            throw new Error("GitHub request exceeds the 1 MiB body limit.");
          if (input.method === "GET" && body !== undefined)
            throw new Error("GET requests must use query parameters.");
          const args = ["api", endpoint, "--hostname", host, "--method", input.method, "--include"];
          for (const [name, value] of [
            ["If-None-Match", input.ifNoneMatch],
            ["If-Modified-Since", input.ifModifiedSince],
          ] as const) {
            if (value === undefined) continue;
            if (/[\r\n]/.test(value) || value.length > 4096)
              throw new Error("Invalid conditional request header.");
            args.push("--header", `${name}: ${value}`);
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
      const perform = Effect.gen(function* () {
        if (resource === "write" && input.expectedGeneration) {
          const current = yield* getCredentialContext({ cwd: input.cwd, host: input.host });
          if (current.generation !== input.expectedGeneration)
            return yield* new GitHubCliError({
              operation: "request",
              kind: "forbidden",
              detail: "The GitHub account changed before the write. Nothing was sent.",
            });
        }
        const result = yield* execute({
          cwd: input.cwd,
          args: prepared.args,
          timeoutMs: prepared.timeoutMs,
          maxStdoutBytes: prepared.maxStdoutBytes,
          allowNonZeroExit: true,
          env: tokenEnvironment(input.host, input.token),
          ...(prepared.body === undefined ? {} : { stdin: prepared.body }),
          ...(input.signal ? { signal: input.signal } : {}),
        });
        if (result.timedOut || result.aborted || result.stdoutTruncated || result.signal) {
          return yield* Effect.fail(
            new GitHubCliError({
              operation: "request",
              kind: result.timedOut ? "timeout" : "invalid_json",
              detail: "GitHub response was interrupted or truncated.",
            }),
          );
        }
        return yield* Effect.try({
          try: () => parseGitHubApiResponse(result.stdout),
          catch: () =>
            new GitHubCliError({
              operation: "request",
              kind: "invalid_json",
              detail: "GitHub returned an incomplete or invalid HTTP response.",
            }),
        });
      });
      const recorded = perform.pipe(
        Effect.tap((response) =>
          Effect.sync(() => {
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
      return yield* scheduler.run(input.host, resource, recorded, {
        searchPages,
        graphql: isGraphql,
      });
    });

  const request = (input: GitHubApiRequest): Effect.Effect<GitHubApiResponse, GitHubCliError> =>
    Effect.suspend(() => {
      const credential = credentials.get(input.context);
      return credential
        ? requestCaptured({
            ...input,
            host: input.context.host,
            token: credential.token,
            expectedGeneration: input.context.generation,
          })
        : Effect.fail(
            new GitHubCliError({
              operation: "request",
              kind: "unauthenticated",
              detail: "Unverified GitHub credential context.",
            }),
          );
    });

  const getCredentialContext = (input: {
    cwd: string;
    host: string;
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
      const envNames = isCloudHost(host)
        ? ["GH_TOKEN", "GITHUB_TOKEN"]
        : ["GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"];
      const tokenFromEnv = envNames
        .map((name) => Object.entries(process.env).find(([key]) => key.toUpperCase() === name)?.[1])
        .find((value) => value?.trim());
      const token =
        tokenFromEnv?.trim() ??
        (yield* execute({
          cwd: input.cwd,
          args: ["auth", "token", "--hostname", host],
          env: cleanEnvironment(),
          maxStdoutBytes: 64 * 1024,
        }).pipe(
          Effect.mapError(
            (error) =>
              new GitHubCliError({
                operation: "credentials",
                kind: error.kind,
                detail: "Could not resolve the GitHub credential.",
              }),
          ),
        )).stdout.trim();
      if (!token || /[\r\n]/.test(token))
        return yield* Effect.fail(
          new GitHubCliError({
            operation: "credentials",
            kind: "unauthenticated",
            detail: "No GitHub credential is available for this host.",
          }),
        );
      const fingerprint = createHash("sha256").update(token).digest("hex");
      if (rejectedCredentials.get(host) === fingerprint)
        return yield* new GitHubCliError({
          operation: "credentials",
          kind: "unauthenticated",
          detail: "The GitHub credential was rejected. Change credentials before retrying.",
        });
      const verified = yield* requestCaptured({
        cwd: input.cwd,
        host,
        token,
        method: "GET",
        endpoint: "user",
      });
      const viewer =
        typeof verified.body === "object" && verified.body !== null
          ? (verified.body as Record<string, unknown>)
          : null;
      if (verified.status !== 200) {
        if (verified.status === 401) rejectedCredentials.set(host, fingerprint);
        const rateLimited =
          verified.status === 429 ||
          (verified.status === 403 &&
            (verified.rateLimit.remaining === 0 || verified.rateLimit.retryAfterSeconds != null));
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
      rejectedCredentials.delete(host);
      const previous = accounts.get(host);
      const generation =
        previous?.viewerId === viewer.id && credentials.get(previous)?.fingerprint === fingerprint
          ? previous.generation
          : randomUUID();
      const context = Object.freeze({ host, viewerId: viewer.id, login: viewer.login, generation });
      credentials.set(context, { token, fingerprint });
      accounts.set(host, context);
      return context;
    });
  return {
    request,
    getCredentialContext: (input: { cwd: string; host: string }) =>
      identityLock.withPermits(1)(getCredentialContext(input)),
  };
}
