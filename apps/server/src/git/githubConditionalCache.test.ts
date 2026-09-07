import { Effect } from "effect";
import { expect, it } from "vitest";
import { makeGitHubConditionalCache } from "./githubConditionalCache.ts";
import type { GitHubApiRequest, GitHubApiResponse } from "./githubApi.ts";

const input: GitHubApiRequest = {
  cwd: "/repo",
  context: { host: "github.com", login: "me", viewerId: 1, generation: "a" },
  method: "GET",
  endpoint: "repos/o/r/pulls/1/files",
  cache: { identity: "comparison-one", validate: Array.isArray },
};
const response = (
  status: number,
  body: unknown,
  etag: string | null = "tag",
): GitHubApiResponse => ({
  status,
  body,
  etag,
  lastModified: null,
  links: {},
  graphqlErrors: [],
  rateLimit: {},
  rateLimitResource: null,
});

it("revalidates cached bodies and isolates accounts, comparisons, and expiry", async () => {
  let now = 0;
  const cached = makeGitHubConditionalCache(() => now);
  await Effect.runPromise(cached(input, () => Effect.succeed(response(200, [{ filename: "a" }]))));
  const unchanged = await Effect.runPromise(
    cached(input, (request) => {
      expect(request.ifNoneMatch).toBe("tag");
      return Effect.succeed(response(304, null));
    }),
  );
  expect(unchanged.status).toBe(200);
  expect(unchanged.body).toEqual([{ filename: "a" }]);
  for (const other of [
    { ...input, context: { ...input.context, generation: "b" } },
    { ...input, cache: { ...input.cache!, identity: "comparison-two" } },
  ])
    await Effect.runPromise(
      cached(other, (request) => {
        expect(request.ifNoneMatch).toBeUndefined();
        return Effect.succeed(response(200, []));
      }),
    );
  now = 30 * 60_000;
  await Effect.runPromise(
    cached(input, (request) => {
      expect(request.ifNoneMatch).toBeUndefined();
      return Effect.succeed(response(200, []));
    }),
  );
});

it("refetches once when 304 has no body and never retains invalid bodies", async () => {
  const cached = makeGitHubConditionalCache();
  let calls = 0;
  const value = await Effect.runPromise(
    cached(input, (request) => {
      expect(request.ifNoneMatch).toBeUndefined();
      return Effect.succeed(++calls === 1 ? response(304, null) : response(200, []));
    }),
  );
  expect(calls).toBe(2);
  expect(value.body).toEqual([]);
  await Effect.runPromise(cached(input, () => Effect.succeed(response(200, { invalid: true }))));
  await Effect.runPromise(
    cached(input, (request) => {
      expect(request.ifNoneMatch).toBeUndefined();
      return Effect.succeed(response(200, []));
    }),
  );
});

it("evicts by byte budget and bypasses caching when not explicitly requested", async () => {
  const cached = makeGitHubConditionalCache(Date.now, 20);
  await Effect.runPromise(cached(input, () => Effect.succeed(response(200, ["large"]))));
  await Effect.runPromise(
    cached(input, (request) => {
      expect(request.ifNoneMatch).toBeUndefined();
      return Effect.succeed(response(200, []));
    }),
  );
  const { cache: _, ...forced } = input;
  await Effect.runPromise(
    cached(forced, (request) => {
      expect(request.ifNoneMatch).toBeUndefined();
      return Effect.succeed(response(200, []));
    }),
  );
});
