import { makeGitHubRequestScheduler } from "./githubRequestScheduler.ts";
import { Effect, Exit, Logger } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GitHubCliError } from "./Errors.ts";
import { GitHubRequestPolicy } from "./githubRequestPolicy.ts";
import type { GitHubCliShape } from "./Services/GitHubCli.ts";
import { makeGitHubApi, parseGitHubApiResponse } from "./githubApi.ts";

afterEach(() => vi.unstubAllEnvs());

function wire(body: unknown, status = 200, headers = "") {
  return `HTTP/2.0 ${status} Response\r\nContent-Type: application/json\r\n${headers}\r\n${JSON.stringify(body)}`;
}

function harness(scheduler = makeGitHubRequestScheduler()) {
  for (const name of ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"])
    vi.stubEnv(name, "");
  let token = "credential-one";
  let response = wire({ ok: true });
  let code = 0;
  let stderr = "";
  const execute = vi.fn<GitHubCliShape["execute"]>((input) =>
    Effect.sync(() => ({
      stdout:
        input.args[0] === "auth"
          ? token
          : input.args[1] === "user"
            ? wire({ id: token === "credential-one" ? 1 : 2, login: "same-login" })
            : response,
      stderr,
      code,
      signal: null,
      timedOut: false,
    })),
  );
  return {
    api: makeGitHubApi(execute, scheduler),
    execute,
    switchAccount: () => {
      token = "credential-two";
    },
    respond: (next: string, nextCode = 0, nextStderr = "") => {
      stderr = nextStderr;
      response = next;
      code = nextCode;
    },
  };
}

describe("credential-bound GitHub requests", () => {
  it("reports a policy rejection as undispatched through the real request primitive", async () => {
    const { api, execute } = harness();
    const context = await Effect.runPromise(
      api.getCredentialContext({ cwd: ".", host: "github.com" }),
    );
    const error = await Effect.runPromise(
      api
        .request({
          cwd: ".",
          context,
          method: "POST",
          endpoint: "repos/org/repo/issues/1/comments",
          body: { body: "text" },
        })
        .pipe(
          Effect.provideService(GitHubRequestPolicy, {
            beforeSend: (write) =>
              write
                ? Effect.fail(
                    new GitHubCliError({
                      operation: "policy",
                      kind: "forbidden",
                      detail: "Excluded while queued",
                    }),
                  )
                : Effect.void,
            readInvalidated: Effect.never,
          }),
          Effect.flip,
        ),
    );
    expect(error.requestDispatched).toBe(false);
    expect(
      execute.mock.calls.filter(([input]) => input.args[1]?.startsWith("repos/")),
    ).toHaveLength(0);
  });
  it("reuses verified identity for an unchanged token and immediately verifies replacements", async () => {
    const { api, execute, switchAccount } = harness();
    const first = await Effect.runPromise(
      api.getCredentialContext({ cwd: ".", host: "github.com" }),
    );
    for (let i = 0; i < 10; i++)
      expect(
        await Effect.runPromise(api.getCredentialContext({ cwd: ".", host: "github.com" })),
      ).toBe(first);
    expect(execute.mock.calls.filter(([input]) => input.args[1] === "user")).toHaveLength(1);
    switchAccount();
    expect(
      (await Effect.runPromise(api.getCredentialContext({ cwd: ".", host: "github.com" })))
        .generation,
    ).not.toBe(first.generation);
    expect(execute.mock.calls.filter(([input]) => input.args[1] === "user")).toHaveLength(2);
  });
  it("suspends credentials rejected by ordinary reads without treating repository permission failures as auth failures", async () => {
    const h = harness();
    const context = await Effect.runPromise(
      h.api.getCredentialContext({ cwd: "/repo", host: "github.com" }),
    );
    const read = () =>
      h.api.request({ cwd: "/repo", context, method: "GET", endpoint: "repos/o/r" });
    h.respond(wire({ message: "forbidden" }, 403));
    expect((await Effect.runPromise(read())).status).toBe(403);
    h.respond(wire({}, 200));
    expect((await Effect.runPromise(read())).status).toBe(200);
    h.respond(wire({}, 401));
    expect((await Effect.runPromise(read())).status).toBe(401);
    const sent = h.execute.mock.calls.length;
    expect((await Effect.runPromise(read().pipe(Effect.flip))).kind).toBe("unauthenticated");
    expect(h.execute.mock.calls.length).toBe(sent);
    h.switchAccount();
    const next = await Effect.runPromise(
      h.api.getCredentialContext({ cwd: "/repo", host: "github.com" }),
    );
    h.respond(wire({}, 200));
    expect(
      (
        await Effect.runPromise(
          h.api.request({ cwd: "/repo", context: next, method: "GET", endpoint: "repos/o/r" }),
        )
      ).status,
    ).toBe(200);
  });
  it.each([
    [429, "", "rate_limited"],
    [403, "Retry-After: 30\r\n", "rate_limited"],
    [403, "", "forbidden"],
    [401, "", "unauthenticated"],
    [503, "", "network"],
  ] as const)(
    "classifies account verification HTTP %s with %s as %s",
    async (status, headers, kind) => {
      vi.stubEnv("GH_TOKEN", "captured-token");
      const execute = vi.fn<GitHubCliShape["execute"]>(() =>
        Effect.succeed({
          stdout: wire({ message: "verification failed" }, status, headers),
          stderr: "",
          code: 1,
          signal: null,
          timedOut: false,
        }),
      );
      const result = await Effect.runPromise(
        makeGitHubApi(execute, makeGitHubRequestScheduler())
          .getCredentialContext({ cwd: "/repo", host: "github.com" })
          .pipe(Effect.flip),
      );
      expect(result.kind).toBe(kind);
      if (headers) expect(result.rateLimit?.retryAfterSeconds).toBe(30);
      expect(execute).toHaveBeenCalledTimes(1);
    },
  );

  it("keeps execution bound to the verified credential across an external account switch", async () => {
    const h = harness();
    const first = await Effect.runPromise(
      h.api.getCredentialContext({ cwd: "/repo", host: "github.com" }),
    );
    h.switchAccount();
    const second = await Effect.runPromise(
      h.api.getCredentialContext({ cwd: "/repo", host: "github.com" }),
    );
    expect(first.viewerId).toBe(1);
    expect(second.viewerId).toBe(2);
    expect(second.generation).not.toBe(first.generation);
    await Effect.runPromise(
      h.api.request({
        cwd: "/repo",
        context: first,
        method: "POST",
        endpoint: "graphql",
        body: {
          query: "query { viewer { login } }",
          variables: { nested: { value: [true, null, 5] } },
        },
      }),
    );
    const request = h.execute.mock.calls.at(-1)![0];
    expect(request.env?.GH_TOKEN).toBe("credential-one");
    expect(request.args).toEqual([
      "api",
      "graphql",
      "--hostname",
      "github.com",
      "--method",
      "POST",
      "--include",
      "--input",
      "-",
    ]);
    expect(JSON.parse(request.stdin!)).toHaveProperty("variables.nested.value", [true, null, 5]);
    expect(JSON.stringify(first)).not.toContain("credential-one");
    expect(JSON.stringify(first)).not.toContain("fingerprint");
  });

  it("re-verifies credentials before a visible write and never redirects it after a switch", async () => {
    const h = harness();
    const context = await Effect.runPromise(
      h.api.getCredentialContext({ cwd: "/repo", host: "github.com" }),
    );
    h.switchAccount();
    h.execute.mockClear();
    const result = await Effect.runPromiseExit(
      h.api.request({
        cwd: "/repo",
        context,
        method: "POST",
        endpoint: "repos/org/repo/issues/1/comments",
        body: { body: "comment" },
      }),
    );
    expect(Exit.isFailure(result)).toBe(true);
    expect(
      h.execute.mock.calls.some(([input]) => input.args[1] === "repos/org/repo/issues/1/comments"),
    ).toBe(false);
  });

  it("isolates identical logins across hosts and removes competing inherited token variables", async () => {
    const h = harness();
    vi.stubEnv("GH_TOKEN", "credential-one");
    vi.stubEnv("GITHUB_TOKEN", "competing");
    vi.stubEnv("GH_ENTERPRISE_TOKEN", "enterprise-credential");
    vi.stubEnv("GITHUB_ENTERPRISE_TOKEN", "competing-enterprise");
    vi.stubEnv("GH_DEBUG", "api");
    const cloud = await Effect.runPromise(
      h.api.getCredentialContext({ cwd: "/repo", host: "github.com" }),
    );
    const enterprise = await Effect.runPromise(
      h.api.getCredentialContext({ cwd: "/repo", host: "git.example.com" }),
    );
    expect(enterprise.generation).not.toBe(cloud.generation);
    const env = h.execute.mock.calls.at(-1)![0].env!;
    expect(env.GH_ENTERPRISE_TOKEN).toBe("enterprise-credential");
    for (const name of ["GH_TOKEN", "GITHUB_TOKEN", "GITHUB_ENTERPRISE_TOKEN", "GH_DEBUG"])
      expect(env[name]).toBeUndefined();
  });

  it("rejects unsafe endpoints, forged accounts and oversized bodies before sending", async () => {
    const h = harness();
    const context = await Effect.runPromise(
      h.api.getCredentialContext({ cwd: "/repo", host: "github.com" }),
    );
    h.execute.mockClear();
    for (const endpoint of [
      "https://elsewhere/user",
      "../user",
      "repos/{owner}/repo",
      "repos/%2e%2e/user",
      "repos/%252e%252e/user",
      "//elsewhere/user",
    ]) {
      expect(
        Exit.isFailure(
          await Effect.runPromiseExit(
            h.api.request({ cwd: "/repo", context, method: "GET", endpoint }),
          ),
        ),
      ).toBe(true);
    }
    expect(
      Exit.isFailure(
        await Effect.runPromiseExit(
          h.api.request({ cwd: "/repo", context: { ...context }, method: "GET", endpoint: "user" }),
        ),
      ),
    ).toBe(true);
    expect(
      Exit.isFailure(
        await Effect.runPromiseExit(
          h.api.request({
            cwd: "/repo",
            context,
            method: "POST",
            endpoint: "graphql",
            body: "x".repeat(1024 * 1024),
          }),
        ),
      ),
    ).toBe(true);
    expect(h.execute).not.toHaveBeenCalled();
  });

  it("retains error bodies and rate metadata on non-zero CLI exit without retrying writes", async () => {
    const h = harness();
    const context = await Effect.runPromise(
      h.api.getCredentialContext({ cwd: "/repo", host: "github.com" }),
    );
    h.respond(
      wire(
        { message: "secondary rate limit" },
        403,
        "Retry-After: 30\r\nX-RateLimit-Remaining: 0\r\nX-RateLimit-Resource: graphql\r\n",
      ),
      1,
    );
    h.execute.mockClear();
    const result = await Effect.runPromise(
      h.api.request({
        cwd: "/repo",
        context,
        method: "POST",
        endpoint: "graphql",
        body: { query: "mutation { example }" },
      }),
    );
    expect(result.status).toBe(403);
    expect(result.body).toEqual({ message: "secondary rate limit" });
    expect(result.rateLimit).toMatchObject({ remaining: 0, retryAfterSeconds: 30 });
    expect(result.rateLimitResource).toBe("graphql");
    expect(h.execute.mock.calls.filter(([input]) => input.args[1] === "graphql")).toHaveLength(1);
  });

  it("does not retry a write after a stdin error", async () => {
    const h = harness();
    const context = await Effect.runPromise(
      h.api.getCredentialContext({ cwd: "/repo", host: "github.com" }),
    );
    h.execute.mockClear();
    h.execute.mockImplementationOnce(() =>
      Effect.fail(
        new GitHubCliError({ operation: "execute", detail: "stdin failed", kind: "network" }),
      ),
    );
    expect(
      Exit.isFailure(
        await Effect.runPromiseExit(
          h.api.request({ cwd: "/repo", context, method: "POST", endpoint: "graphql", body: {} }),
        ),
      ),
    ).toBe(true);
    expect(h.execute).toHaveBeenCalledTimes(1);
  });
});

describe("GitHub HTTP envelope", () => {
  it("parses conditional responses, mixed-case headers and pagination", () => {
    const result = parseGitHubApiResponse(
      'HTTP/2.0 304 Not Modified\nETag: "cached"\nlast-modified: yesterday\nLink: <https://api.github.com/x?page=2>; rel="next"\n\n',
    );
    expect(result).toMatchObject({
      status: 304,
      body: null,
      etag: '"cached"',
      lastModified: "yesterday",
      links: { next: "https://api.github.com/x?page=2" },
    });
  });
  it("preserves GraphQL errors alongside partial data", () => {
    expect(
      parseGitHubApiResponse(
        wire({ data: { partial: true }, errors: [{ message: "missing field" }] }),
      ).graphqlErrors,
    ).toEqual([{ message: "missing field" }]);
  });
  it("rejects truncated JSON and missing headers", () => {
    expect(() =>
      parseGitHubApiResponse('HTTP/2.0 200 OK\nContent-Type: application/json\n\n{"data":'),
    ).toThrow();
    expect(() => parseGitHubApiResponse("{}")).toThrow();
  });
});

describe("GitHub response failures", () => {
  it.each(["upstream timeout", "<html>Gateway Timeout</html>", "", '{"message":"timeout"}'])(
    "preserves HTTP errors and retry headers for body %j",
    (body) => {
      const response = parseGitHubApiResponse(
        `HTTP/2.0 504 Gateway Timeout\r\nContent-Type: text/plain\r\nRetry-After: 30\r\nX-RateLimit-Remaining: 12\r\n\r\n${body}`,
      );
      expect(response.status).toBe(504);
      expect(response.rateLimit).toMatchObject({ retryAfterSeconds: 30, remaining: 12 });
      expect(response.body).toEqual(body.startsWith("{") ? { message: "timeout" } : null);
    },
  );

  it("backs off on a plain-text 504 and recovers after the retry window", async () => {
    let now = Date.parse("2026-09-07T13:00:00Z");
    const scheduler = makeGitHubRequestScheduler(
      () => now,
      () => 0.5,
    );
    const h = harness(scheduler);
    const context = await Effect.runPromise(
      h.api.getCredentialContext({ cwd: ".", host: "github.com" }),
    );
    const read = () =>
      h.api.request({
        cwd: ".",
        context,
        method: "POST",
        endpoint: "graphql",
        body: { query: "query { viewer { login } }" },
      });
    h.respond("HTTP/2.0 504 Gateway Timeout\nContent-Type: text/plain\n\nupstream timeout", 1);
    expect((await Effect.runPromise(read())).status).toBe(504);
    expect(scheduler.status("github.com").retryAt).toBe(new Date(now + 30_000).toISOString());
    const sent = h.execute.mock.calls.length;
    expect((await Effect.runPromise(read().pipe(Effect.flip))).requestDispatched).toBe(false);
    expect(h.execute).toHaveBeenCalledTimes(sent);
    now += 30_001;
    h.respond(wire({ data: { viewer: { login: "me" } } }));
    expect((await Effect.runPromise(read())).status).toBe(200);
    expect(h.execute).toHaveBeenCalledTimes(sent + 1);
    expect(scheduler.status("github.com").retryAt).toBeNull();
  });

  it("retains non-JSON rate-limit responses on nonzero exit", async () => {
    const scheduler = makeGitHubRequestScheduler();
    const h = harness(scheduler);
    const context = await Effect.runPromise(
      h.api.getCredentialContext({ cwd: ".", host: "github.com" }),
    );
    h.respond("HTTP/2.0 429 Too Many Requests\nRetry-After: 60\n\nrate limited", 1);
    const response = await Effect.runPromise(
      h.api.request({ cwd: ".", context, method: "GET", endpoint: "repos/o/r" }),
    );
    expect(response).toMatchObject({
      status: 429,
      body: null,
      rateLimit: { retryAfterSeconds: 60 },
    });
    expect(scheduler.status("github.com").retryAt).not.toBeNull();
  });

  it.each([
    ["connection reset by peer", "network"],
    ["To get started with GitHub CLI, please run: gh auth login", "unauthenticated"],
    ["request timed out", "timeout"],
    ["unexpected CLI failure", "generic"],
  ])("classifies missing HTTP output: %s", async (stderr, kind) => {
    const h = harness();
    const context = await Effect.runPromise(
      h.api.getCredentialContext({ cwd: ".", host: "github.com" }),
    );
    h.respond("", 1, stderr);
    const error = await Effect.runPromise(
      h.api.request({ cwd: ".", context, method: "GET", endpoint: "repos/o/r" }).pipe(Effect.flip),
    );
    expect(error.kind).toBe(kind);
    expect(error.cause).toBeUndefined();
  });

  it("preserves GraphQL partial data despite nonzero exit", async () => {
    const h = harness();
    const context = await Effect.runPromise(
      h.api.getCredentialContext({ cwd: ".", host: "github.com" }),
    );
    const body = { data: { partial: true }, errors: [{ message: "unavailable" }] };
    h.respond(wire(body), 1, "gh: unavailable");
    const response = await Effect.runPromise(
      h.api.request({
        cwd: ".",
        context,
        method: "POST",
        endpoint: "graphql",
        body: { query: "query { viewer { login } }" },
      }),
    );
    expect(response.body).toEqual(body);
    expect(response.graphqlErrors).toEqual(body.errors);
  });

  it.each([
    ["", "headers_missing_or_oversized", null],
    ["HTTP/2.0 200 OK\nContent-Type: application/json", "headers_missing_or_oversized", 200],
    ["not-http\nHeader: value\n\n{}", "invalid_status", null],
    ["HTTP/2.0 200 OK\ninvalid-header\n\n{}", "invalid_header", 200],
    [
      'HTTP/2.0 200 OK\nContent-Type: application/json\n\n{"secret":"private-payload",',
      "invalid_json",
      200,
    ],
  ] as const)(
    "logs bounded metadata for invalid responses (%s)",
    async (stdout, category, status) => {
      const h = harness();
      const context = await Effect.runPromise(
        h.api.getCredentialContext({ cwd: ".", host: "github.com" }),
      );
      const logs: unknown[] = [];
      h.respond(stdout, 0, "private-stderr");
      const error = await Effect.runPromise(
        h.api
          .request({
            cwd: ".",
            context,
            method: "GET",
            endpoint: "repos/o/r",
            query: { secret: "private-query" },
          })
          .pipe(
            Effect.flip,
            Effect.provide(
              Logger.layer([
                Logger.make((options) => {
                  logs.push(options.message);
                }),
              ]),
            ),
          ),
      );
      expect(error.kind).toBe("invalid_json");
      expect(logs).toEqual([
        [
          "GitHub API response could not be parsed",
          {
            endpoint: "repos/o/r",
            exitCode: 0,
            stdoutBytes: Buffer.byteLength(stdout),
            stderrBytes: Buffer.byteLength("private-stderr"),
            status,
            category,
          },
        ],
      ]);
      expect(JSON.stringify(logs)).not.toMatch(
        /private-payload|private-stderr|private-query|credential-one/,
      );
    },
  );

  it.each(["timedOut", "aborted", "stdoutTruncated", "signal"] as const)(
    "rejects interrupted output even with a complete HTTP error: %s",
    async (flag) => {
      const h = harness();
      const context = await Effect.runPromise(
        h.api.getCredentialContext({ cwd: ".", host: "github.com" }),
      );
      h.execute.mockImplementationOnce(() =>
        Effect.succeed({
          stdout: "HTTP/2.0 504 Gateway Timeout\nContent-Type: text/plain\n\ntimeout",
          stderr: "",
          code: 1,
          signal: null,
          timedOut: false,
          [flag]: flag === "signal" ? "SIGTERM" : true,
        }),
      );
      const error = await Effect.runPromise(
        h.api
          .request({ cwd: ".", context, method: "GET", endpoint: "repos/o/r" })
          .pipe(Effect.flip),
      );
      expect(error.kind).toBe(flag === "timedOut" ? "timeout" : "invalid_json");
    },
  );

  it("accepts a bodyless 204 but rejects an empty successful JSON response", () => {
    expect(parseGitHubApiResponse("HTTP/2.0 204 No Content\n\n").body).toBeNull();
    expect(() => parseGitHubApiResponse("HTTP/2.0 200 OK\n\n")).toThrow();
  });
});
