import { makeGitHubRequestScheduler } from "./githubRequestScheduler.ts";
import { Effect, Exit } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GitHubCliError } from "./Errors.ts";
import type { GitHubCliShape } from "./Services/GitHubCli.ts";
import { makeGitHubApi, parseGitHubApiResponse } from "./githubApi.ts";

afterEach(() => vi.unstubAllEnvs());

function wire(body: unknown, status = 200, headers = "") {
  return `HTTP/2.0 ${status} Response\r\nContent-Type: application/json\r\n${headers}\r\n${JSON.stringify(body)}`;
}

function harness() {
  for (const name of ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"])
    vi.stubEnv(name, "");
  let token = "credential-one";
  let response = wire({ ok: true });
  let code = 0;
  const execute = vi.fn<GitHubCliShape["execute"]>((input) =>
    Effect.sync(() => ({
      stdout:
        input.args[0] === "auth"
          ? token
          : input.args[1] === "user"
            ? wire({ id: token === "credential-one" ? 1 : 2, login: "same-login" })
            : response,
      stderr: "",
      code,
      signal: null,
      timedOut: false,
    })),
  );
  return {
    api: makeGitHubApi(execute, makeGitHubRequestScheduler()),
    execute,
    switchAccount: () => {
      token = "credential-two";
    },
    respond: (next: string, nextCode = 0) => {
      response = next;
      code = nextCode;
    },
  };
}

describe("credential-bound GitHub requests", () => {
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
