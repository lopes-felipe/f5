import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import { makeFakeGitHubCli } from "../git/testDoubles.ts";
import { readGitHubStack } from "./githubStacks.ts";
const ref = {
  provider: "github" as const,
  host: "github.example",
  repository: "team/repo",
  number: 7,
};
const layer = { number: 7, title: "Top", head: { ref: "feature", sha: "head" } };
const stack = { number: 1, base: { ref: "main" }, pull_requests: [layer] };
function read(body: unknown, status = 200) {
  const fake = makeFakeGitHubCli().service;
  return Effect.runPromise(
    readGitHubStack(
      {
        ...fake,
        getCredentialContext: () =>
          Effect.succeed({
            host: ref.host,
            viewerId: 1,
            login: "reader",
            generation: "generation",
          }),
        request: () =>
          Effect.succeed({
            status,
            body,
            graphqlErrors: [],
            links: {},
            etag: null,
            lastModified: null,
            rateLimit: {},
            rateLimitResource: null,
          }),
      },
      "/repo",
      ref,
    ),
  );
}
describe("GitHub native stacks", () => {
  it.each([404, 422])("hides unavailable stack preview (%s)", async (status) =>
    expect(await read({}, status)).toBeNull(),
  );
  it("preserves layer order and pins fingerprints to every revision", async () => {
    const first = await read([stack]);
    expect(first?.layers[0]).toMatchObject({ number: 7, baseRef: "main", headOid: "head" });
    const changed = await read([
      { ...stack, pull_requests: [{ ...layer, head: { ...layer.head, sha: "pushed" } }] },
    ]);
    expect(changed?.fingerprint).not.toBe(first?.fingerprint);
  });
  it("rejects malformed layers instead of guessing a revision", async () => {
    await expect(
      read([{ ...stack, pull_requests: [{ ...layer, head: { ref: "feature" } }] }]),
    ).rejects.toThrow();
  });
  it("does not hide authentication failures as an unsupported preview", async () => {
    await expect(read({}, 403)).rejects.toThrow();
  });
});
