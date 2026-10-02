import { createHash } from "node:crypto";
import { Effect, Schema } from "effect";
import { PrHubStack, type SourceControlPullRequestRef } from "@t3tools/contracts";
import type { GitHubCliShape } from "../git/Services/GitHubCli.ts";
import { mapGitHubCliError } from "../sourceControl/GitHubSourceControlProvider.ts";
import { SourceControlProviderError } from "../sourceControl/SourceControlProvider.ts";
import { record, text } from "./forgeModel.ts";

export function readGitHubStack(
  github: GitHubCliShape,
  cwd: string,
  ref: SourceControlPullRequestRef,
) {
  return Effect.gen(function* () {
    const context = yield* github
      .getCredentialContext({ cwd, host: ref.host })
      .pipe(Effect.mapError(mapGitHubCliError));
    const response = yield* github
      .request({
        cwd,
        context,
        method: "GET",
        endpoint: `repos/${ref.repository}/stacks`,
        query: { pull_request: ref.number },
      })
      .pipe(Effect.mapError(mapGitHubCliError));
    if (response.status === 404 || response.status === 422) return null;
    if (response.status !== 200)
      return yield* new SourceControlProviderError({
        provider: "github",
        operation: "stacks.read",
        kind: "generic",
        detail: `GitHub stack read failed (${response.status}).`,
      });
    if (!Array.isArray(response.body))
      return yield* new SourceControlProviderError({
        provider: "github",
        operation: "stacks.read",
        kind: "invalid_response",
        detail: "Invalid GitHub stack response.",
      });
    if (!response.body[0]) return null;
    const raw = record(response.body[0]);
    const base = text(raw.base) ?? text(record(raw.base).ref);
    if (!base || !Array.isArray(raw.pull_requests) || raw.pull_requests.length > 100)
      return yield* new SourceControlProviderError({
        provider: "github",
        operation: "stacks.read",
        kind: "invalid_response",
        detail: "Invalid GitHub stack layers.",
      });
    const layers = raw.pull_requests.map((value, index) => {
      const r = record(value),
        head = record(r.head),
        previous = record(
          raw.pull_requests && Array.isArray(raw.pull_requests)
            ? raw.pull_requests[index - 1]
            : null,
        );
      return {
        number: r.number,
        title: r.title ?? `PR #${r.number}`,
        url: `https://${ref.host}/${ref.repository}/pull/${r.number}`,
        headOid: head.sha,
        state: r.merged_at ? "merged" : r.state === "closed" ? "closed" : "open",
        isDraft: r.draft === true,
        baseRef: index === 0 ? base : record(previous.head).ref,
        headRef: head.ref,
      };
    });
    const fingerprint = createHash("sha256")
      .update(JSON.stringify([raw.number, layers]))
      .digest("hex");
    return yield* Schema.decodeUnknownEffect(PrHubStack)({
      number: raw.number,
      fingerprint,
      layers,
    }).pipe(
      Effect.mapError(
        () =>
          new SourceControlProviderError({
            provider: "github",
            operation: "stacks.read",
            kind: "invalid_response",
            detail: "GitHub omitted a stack revision.",
          }),
      ),
    );
  });
}
