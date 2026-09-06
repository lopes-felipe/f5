import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { GitHubApiResponse } from "../git/githubApi.ts";
import { SourceControlProviderError } from "../sourceControl/SourceControlProvider.ts";
import { ingestPrHubSearch, type DiscoveryAccount } from "./discovery.ts";

const record = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

/** Notification URLs are evidence only; never forward a provider-supplied URL to the transport. */
export function notificationPullRequest(value: unknown, host: string) {
  const item = record(value);
  const subject = record(item?.subject);
  const repository = record(item?.repository);
  if (subject?.type !== "PullRequest" || typeof subject.url !== "string") return null;
  try {
    const url = new URL(subject.url);
    const expectedHost = host === "github.com" ? "api.github.com" : host;
    if (url.protocol !== "https:" || url.host !== expectedHost || url.username || url.password)
      return null;
    const match =
      /^(?:\/api\/v3)?\/repos\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/pulls\/([1-9][0-9]*)$/.exec(
        url.pathname,
      );
    if (!match || repository?.full_name !== match[1]) return null;
    return {
      repository: match[1]!,
      endpoint: `repos/${match[1]}/pulls/${match[2]}`,
      reason: item?.reason,
    };
  } catch {
    return null;
  }
}

/** One bounded page per poll. A failed page retains its checkpoint; notification read state is untouched. */
export function discoverNotificationSubjects(
  account: DiscoveryAccount,
  excluded: ReadonlySet<string>,
  read: (
    endpoint: string,
    query?: Record<string, string | number | boolean>,
  ) => Effect.Effect<GitHubApiResponse, SourceControlProviderError>,
  now = Date.now(),
) {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ payload_json: string }>`SELECT payload_json FROM pr_hub_sync_tasks
      WHERE provider_kind = 'github' AND host = ${account.host} AND viewer_id = ${account.viewerId}
        AND kind = 'notification_scope' AND task_key = 'subjects'`;
    const previous = rows[0]
      ? (JSON.parse(rows[0].payload_json) as {
          page: number;
          since: string | null;
          startedAt: number;
          complete: boolean;
          repairedAt?: number;
        })
      : null;
    const state =
      previous && !previous.complete
        ? previous
        : {
            page: 1,
            since:
              previous && now - (previous.repairedAt ?? previous.startedAt) < 6 * 60 * 60_000
                ? new Date(Math.max(0, previous.startedAt - 10 * 60_000)).toISOString()
                : null,
            startedAt: now,
            complete: false,
            repairedAt: previous?.repairedAt ?? previous?.startedAt ?? now,
          };
    const response = yield* read("notifications", {
      all: true,
      per_page: 20,
      page: state.page,
      before: new Date(state.startedAt).toISOString(),
      ...(state.since ? { since: state.since } : {}),
    });
    if (!Array.isArray(response.body) || response.body.length > 20)
      return yield* new SourceControlProviderError({
        provider: "github",
        operation: "prHub.notifications",
        kind: "invalid_response",
        detail: "Notification discovery returned an incomplete page.",
      });
    const visited = new Set<string>();
    for (const raw of response.body) {
      const subject = notificationPullRequest(raw, account.host);
      if (!subject || excluded.has(subject.repository.toLowerCase())) continue;
      if (visited.has(subject.endpoint)) continue;
      visited.add(subject.endpoint);
      const response = yield* read(subject.endpoint);
      const pr = record(response.body);
      if (typeof pr?.node_id !== "string")
        return yield* new SourceControlProviderError({
          provider: "github",
          operation: "prHub.notifications",
          kind: "invalid_response",
          detail: "A notification subject could not be verified as a pull request.",
        });
      yield* ingestPrHubSearch(
        account,
        {
          alias: subject.reason === "mention" ? "mentioned" : "involved",
          query: "notification-subject",
          cursor: null,
        },
        {
          nodes: [
            {
              id: pr.node_id,
              updatedAt: pr.updated_at,
              repository: { nameWithOwner: subject.repository },
            },
          ],
          issueCount: 1,
          pageInfo: { hasNextPage: false, endCursor: null },
        },
        excluded,
        now,
      );
    }
    const complete = !response.links.next;
    const next = {
      ...state,
      page: complete ? 1 : state.page + 1,
      complete,
      repairedAt: complete && state.since === null ? now : state.repairedAt,
    };
    const timestamp = new Date(now).toISOString();
    yield* sql`INSERT INTO pr_hub_sync_tasks(provider_kind, host, viewer_id, kind, task_key, payload_json, created_at, updated_at)
      VALUES ('github', ${account.host}, ${account.viewerId}, 'notification_scope', 'subjects', ${JSON.stringify(next)}, ${timestamp}, ${timestamp})
      ON CONFLICT(provider_kind, host, viewer_id, kind, task_key) DO UPDATE SET payload_json = excluded.payload_json, updated_at = excluded.updated_at`;
    return complete;
  });
}
