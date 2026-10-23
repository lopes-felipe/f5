import type { SourceControlPullRequestRef } from "@t3tools/contracts";
import { Effect, Option } from "effect";
import { ServerSettingsService } from "../serverSettings.ts";
import { GitHubCliError } from "./Errors.ts";
import { removeAgentCredits } from "./mergeMessage.ts";

export const mergeCreditRemovalEnabled = (override?: boolean) =>
  Effect.gen(function* () {
    if (override !== undefined) return override;
    const settings = yield* Effect.serviceOption(ServerSettingsService);
    if (Option.isNone(settings)) return false;
    return (yield* settings.value.getSettings.pipe(
      Effect.mapError(
        () =>
          new GitHubCliError({
            operation: "mergeMessage",
            detail: "Could not read merge-message settings.",
            kind: "generic",
          }),
      ),
    )).removeAgentCreditsOnMerge;
  });
const QUERY = `query F5PullRequestMergeMessage($owner:String!,$name:String!,$number:Int!,$method:PullRequestMergeMethod!) {
  repository(owner:$owner,name:$name) { pullRequest(number:$number) {
    isMergeQueueEnabled headRefOid viewerMergeBodyText(mergeType:$method)
  } }
}`;
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/** Read the host's proposed body, and override only when recognized credits actually changed it. */
export function readGitHubMergeMessage<E>(input: {
  readonly ref: SourceControlPullRequestRef;
  readonly method: "merge" | "squash" | "rebase";
  readonly enabled: boolean;
  readonly expectedHeadOid?: string | undefined;
  readonly query: (
    query: string,
    variables: Record<string, string | number>,
  ) => Effect.Effect<unknown, E>;
  readonly invalid: (detail: string) => E;
}): Effect.Effect<{ commitBody?: string; expectedHeadOid?: string }, E> {
  return Effect.gen(function* () {
    if (!input.enabled || input.method === "rebase") return {};
    const [owner, name] = input.ref.repository.split("/");
    const raw = record(
      yield* input.query(QUERY, {
        owner: owner!,
        name: name!,
        number: input.ref.number,
        method: input.method === "squash" ? "SQUASH" : "MERGE",
      }),
    );
    const pr = record(record(record(raw.data).repository).pullRequest);
    if (
      (Array.isArray(raw.errors) && raw.errors.length) ||
      typeof pr.isMergeQueueEnabled !== "boolean" ||
      typeof pr.headRefOid !== "string" ||
      !pr.headRefOid ||
      typeof pr.viewerMergeBodyText !== "string" ||
      pr.viewerMergeBodyText.length > 262144
    )
      return yield* Effect.fail(
        input.invalid("GitHub did not provide a complete proposed merge message."),
      );
    if (input.expectedHeadOid && input.expectedHeadOid !== pr.headRefOid)
      return yield* Effect.fail(
        input.invalid("The PR head changed while reading its merge message. Reopen the preview."),
      );
    if (pr.isMergeQueueEnabled) return {};
    const cleaned = removeAgentCredits(pr.viewerMergeBodyText);
    return cleaned === pr.viewerMergeBodyText
      ? {}
      : { commitBody: cleaned, expectedHeadOid: pr.headRefOid };
  });
}
