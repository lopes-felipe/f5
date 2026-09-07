import { Effect, Exit, Schema } from "effect";
import type { SourceControlProviderError } from "../sourceControl/SourceControlProvider.ts";

const MergeState = Schema.Struct({
  id: Schema.String,
  headRefOid: Schema.String,
  baseRefOid: Schema.String,
  mergeable: Schema.String,
  mergeStateStatus: Schema.String,
});
const Response = Schema.Struct({
  data: Schema.Struct({ nodes: Schema.Array(Schema.NullOr(MergeState)) }),
});
export const PR_HUB_MERGE_STATE_QUERY = `query PrHubMergeState($ids:[ID!]!) {
  nodes(ids:$ids) { ... on PullRequest { id headRefOid baseRefOid mergeable mergeStateStatus } }
  rateLimit { cost remaining limit resetAt }
}`;

/** Recheck calculation only; revision changes require a fresh full hydration. */
export function recheckUnknownMergeStates(
  candidates: readonly { id: string; headRefOid: string; baseRefOid: string }[],
  query: (ids: readonly string[]) => Effect.Effect<unknown, SourceControlProviderError>,
  wait: (milliseconds: number) => Effect.Effect<void> = (milliseconds) =>
    Effect.sleep(milliseconds),
) {
  return Effect.gen(function* () {
    const pending = new Map(candidates.map((candidate) => [candidate.id, candidate]));
    const verified = new Map<string, typeof MergeState.Type>();
    for (const delay of [5000, 10000, 15000]) {
      if (!pending.size) break;
      yield* wait(delay);
      const response = yield* Effect.exit(query([...pending.keys()]));
      if (Exit.isFailure(response)) break; // The host scheduler owns retry/reset budgets.
      const decoded = Schema.decodeUnknownOption(Response)(response.value);
      if (decoded._tag === "None") break;
      for (const node of decoded.value.data.nodes) {
        if (!node) continue;
        const expected = pending.get(node.id);
        if (!expected) continue;
        if (node.headRefOid !== expected.headRefOid || node.baseRefOid !== expected.baseRefOid) {
          pending.delete(node.id);
          continue;
        }
        if (node.mergeable !== "UNKNOWN" && node.mergeStateStatus !== "UNKNOWN") {
          verified.set(node.id, node);
          pending.delete(node.id);
        }
      }
    }
    return verified;
  });
}
