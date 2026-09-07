import { Effect } from "effect";
import type { GitHubApiRequest, GitHubApiResponse } from "./githubApi.ts";
import { GitHubCliError } from "./Errors.ts";

export interface GitHubConditionalRead {
  readonly identity: string;
  readonly validate: (body: unknown) => boolean;
}
interface Entry {
  response: GitHubApiResponse;
  bytes: number;
  at: number;
}

/** The remaining 8 MiB of PR Hub's 128 MiB budget; detail caches own 3 × 40 MiB. */
export function makeGitHubConditionalCache(now = Date.now, budget = 8 * 1024 * 1024) {
  const entries = new Map<string, Entry>();
  let bytes = 0;
  const remove = (key: string) => {
    bytes -= entries.get(key)?.bytes ?? 0;
    entries.delete(key);
  };
  const read = (key: string) => {
    const entry = entries.get(key);
    if (!entry) return;
    if (now() - entry.at >= 30 * 60_000) {
      remove(key);
      return;
    }
    entries.delete(key);
    entries.set(key, entry);
    return entry;
  };
  return (
    input: GitHubApiRequest,
    send: (request: GitHubApiRequest) => Effect.Effect<GitHubApiResponse, GitHubCliError>,
  ) =>
    Effect.gen(function* () {
      const policy = input.cache;
      if (!policy || input.method !== "GET") return yield* send(input);
      const key = JSON.stringify([
        input.context.host,
        input.context.generation,
        input.endpoint,
        Object.entries(input.query ?? {}).sort(([a], [b]) => a.localeCompare(b)),
        policy.identity,
      ]);
      const cached = read(key);
      const conditional = cached?.response.etag
        ? { ifNoneMatch: cached.response.etag }
        : cached?.response.lastModified
          ? { ifModifiedSince: cached.response.lastModified }
          : {};
      let response = yield* send({ ...input, ...conditional });
      if (response.status === 304) {
        const current = read(key);
        if (current && current === cached)
          response = {
            ...current.response,
            ...response,
            status: 200,
            body: current.response.body,
            links: current.response.links,
            etag: response.etag ?? current.response.etag,
            lastModified: response.lastModified ?? current.response.lastModified,
          };
        else
          response = yield* send({ ...input, ifNoneMatch: undefined, ifModifiedSince: undefined });
        if (response.status === 304)
          return yield* new GitHubCliError({
            operation: "request",
            kind: "invalid_json",
            detail: "GitHub returned an unchanged response without a cached body.",
          });
      }
      const valid = yield* Effect.sync(() => {
        try {
          return policy.validate(response.body);
        } catch {
          return false;
        }
      });
      if (response.status === 200 && valid && (response.etag || response.lastModified)) {
        remove(key);
        const size = Buffer.byteLength(JSON.stringify(response), "utf8");
        if (size <= Math.min(budget, 8 * 1024 * 1024)) {
          entries.set(key, { response, at: now(), bytes: size });
          bytes += size;
          while (bytes > budget || entries.size > 128) remove(entries.keys().next().value!);
        }
      } else if (response.status !== 304) remove(key);
      return response;
    });
}
