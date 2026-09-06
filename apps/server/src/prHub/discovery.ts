import { continuePrConnectionPagination } from "./attentionPagination.ts";
import { createHash, randomUUID } from "node:crypto";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { SourceControlProviderError } from "../sourceControl/SourceControlProvider.ts";

export interface DiscoveryAccount {
  host: string;
  viewerId: string;
  viewerLogin?: string;
  viewerTeams?: readonly string[];
}
export interface SearchTask {
  enumerateRepository?: boolean;
  sourceKey?: string;
  intervalEnd?: number;
  alias: string;
  query: string;
  cursor: string | null;
  queued?: boolean;
  from?: number;
  to?: number;
}
interface HydrationTask {
  priority?: number;
  nodeId: string;
  aliases: string[];
  repository: string | null;
  updatedAt: string | null;
}
const record = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
const string = (value: unknown) => (typeof value === "string" ? value : null);
const taskKey = (task: SearchTask) =>
  createHash("sha256")
    .update(
      JSON.stringify({
        alias: task.alias,
        query: task.query,
        from: task.from,
        to: task.to,
        enumerateRepository: task.enumerateRepository,
      }),
    )
    .digest("hex");

interface SourceWatermark {
  watermark: number | null;
  repairedAt: number | null;
  task: SearchTask;
  complete: boolean;
  repair: boolean;
}

/** A verified membership change invalidates traversal checkpoints, never drafts or viewer preferences. */
export function recordPrHubMembership(
  account: DiscoveryAccount,
  source: "teams" | "repositories",
  members: readonly string[],
) {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const digest = createHash("sha256")
          .update(
            JSON.stringify([...new Set(members.map((member) => member.toLowerCase()))].sort()),
          )
          .digest("hex");
        const previous = yield* sql<{
          payload_json: string;
        }>`SELECT payload_json FROM pr_hub_sync_tasks
        WHERE provider_kind = 'github' AND host = ${account.host} AND viewer_id = ${account.viewerId} AND kind = 'membership' AND task_key = ${source}`;
        const old = previous[0]
          ? (JSON.parse(previous[0].payload_json) as { digest: string; generation: string })
          : null;
        if (old?.digest === digest) return { generation: old.generation, changed: false };
        const generation = randomUUID();
        const now = new Date().toISOString();
        yield* sql`INSERT INTO pr_hub_sync_tasks(provider_kind, host, viewer_id, kind, task_key, payload_json, created_at, updated_at)
        VALUES ('github', ${account.host}, ${account.viewerId}, 'membership', ${source}, ${JSON.stringify({ digest, generation })}, ${now}, ${now})
        ON CONFLICT(provider_kind, host, viewer_id, kind, task_key) DO UPDATE SET payload_json = excluded.payload_json, updated_at = excluded.updated_at`;
        if (old) {
          yield* sql`DELETE FROM pr_hub_sync_tasks WHERE provider_kind = 'github' AND host = ${account.host} AND viewer_id = ${account.viewerId}
          AND kind IN ('search', 'source_watermark', 'search_scope')`;
          yield* sql`UPDATE pr_hub_sync_tasks SET payload_json = json_set(payload_json, '$.searchedAt', 0)
          WHERE provider_kind = 'github' AND host = ${account.host} AND viewer_id = ${account.viewerId} AND kind = 'known_repository'`;
        }
        return { generation, changed: old !== null };
      }),
    );
  });
}

/** An interval advances only when every page and partition has been durably ingested. */
export function beginPrHubSearch(
  account: DiscoveryAccount,
  alias: string,
  query: string,
  now = Date.now(),
) {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const sourceKey = createHash("sha256")
      .update(JSON.stringify([alias, query]))
      .digest("hex");
    const rows = yield* sql<{ payload_json: string }>`SELECT payload_json FROM pr_hub_sync_tasks
      WHERE provider_kind = 'github' AND host = ${account.host} AND viewer_id = ${account.viewerId}
        AND kind = 'source_watermark' AND task_key = ${sourceKey}`;
    const previous = rows[0] ? (JSON.parse(rows[0].payload_json) as SourceWatermark) : null;
    if (previous && !previous.complete) return previous.task;
    const repair = previous?.repairedAt == null || now - previous.repairedAt >= 6 * 60 * 60_000;
    const bounds =
      !repair && previous?.watermark != null
        ? ` updated:${new Date(Math.max(0, previous.watermark - 10 * 60_000)).toISOString()}..${new Date(now).toISOString()}`
        : ` updated:<=${new Date(now).toISOString()}`;
    const task: SearchTask = {
      alias,
      query: query + bounds,
      cursor: null,
      sourceKey,
      intervalEnd: now,
    };
    const state: SourceWatermark = {
      watermark: previous?.watermark ?? null,
      repairedAt: previous?.repairedAt ?? null,
      task,
      complete: false,
      repair,
    };
    const timestamp = new Date(now).toISOString();
    yield* sql`INSERT INTO pr_hub_sync_tasks(provider_kind, host, viewer_id, kind, task_key, payload_json, created_at, updated_at)
      VALUES ('github', ${account.host}, ${account.viewerId}, 'source_watermark', ${sourceKey}, ${JSON.stringify(state)}, ${timestamp}, ${timestamp})
      ON CONFLICT(provider_kind, host, viewer_id, kind, task_key) DO UPDATE SET payload_json = excluded.payload_json, updated_at = excluded.updated_at`;
    return task;
  });
}

export const PR_HUB_CONTINUATION_QUERY = `query PrHubSearchContinuation($query:String!,$cursor:String){
  result: search(query:$query,type:ISSUE,first:100,after:$cursor){
    issueCount nodes { ... on PullRequest { id updatedAt repository { nameWithOwner } } }
    pageInfo { hasNextPage endCursor }
  }
  rateLimit { cost remaining limit resetAt }
}`;

/** Store each unfinished page independently, so an interruption loses no discovered IDs. */
export function ingestPrHubSearch(
  account: DiscoveryAccount,
  task: SearchTask,
  raw: unknown,
  excluded: ReadonlySet<string>,
  now = Date.now(),
) {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const connection = record(raw);
    const timestamp = new Date(now).toISOString();
    const page = record(connection?.pageInfo);
    if (
      !connection ||
      !Array.isArray(connection.nodes) ||
      typeof page?.hasNextPage !== "boolean" ||
      (page.hasNextPage &&
        (typeof page.endCursor !== "string" || !page.endCursor || page.endCursor === task.cursor))
    ) {
      // Preserve the exact failed page. Missing pagination is not evidence of an empty scope.
      yield* sql`INSERT INTO pr_hub_sync_tasks(provider_kind, host, viewer_id, kind, task_key, payload_json, created_at, updated_at)
        VALUES ('github', ${account.host}, ${account.viewerId}, 'search', ${taskKey(task)}, ${JSON.stringify({ ...task, queued: true })}, ${timestamp}, ${timestamp})
        ON CONFLICT(provider_kind, host, viewer_id, kind, task_key) DO NOTHING`;
      return { partial: true, saturated: false };
    }
    const nodes = connection.nodes;
    yield* sql.withTransaction(
      Effect.gen(function* () {
        for (const item of nodes) {
          const node = record(item);
          const nodeId = string(node?.id);
          const repository = string(record(node?.repository)?.nameWithOwner);
          if (!nodeId || (repository && excluded.has(repository.toLowerCase()))) continue;
          const existing = yield* sql<{
            payload_json: string;
          }>`SELECT payload_json FROM pr_hub_sync_tasks
          WHERE provider_kind = 'github' AND host = ${account.host} AND viewer_id = ${account.viewerId} AND kind = 'hydrate' AND task_key = ${nodeId}`;
          const previous = existing[0]
            ? (JSON.parse(existing[0].payload_json) as HydrationTask)
            : null;
          const payload: HydrationTask = {
            priority: Math.max(
              previous?.priority ?? 0,
              /^(review_requested|team_review|mentioned)/.test(task.alias) ? 2 : 1,
            ),
            nodeId,
            repository,
            updatedAt: string(node?.updatedAt),
            aliases: [...new Set([...(previous?.aliases ?? []), task.alias])],
          };
          yield* sql`INSERT INTO pr_hub_sync_tasks(provider_kind, host, viewer_id, kind, task_key, payload_json, created_at, updated_at)
          VALUES ('github', ${account.host}, ${account.viewerId}, 'hydrate', ${nodeId}, ${JSON.stringify(payload)}, ${timestamp}, ${payload.updatedAt ?? timestamp})
          ON CONFLICT(provider_kind, host, viewer_id, kind, task_key) DO UPDATE SET payload_json = excluded.payload_json, updated_at = excluded.updated_at`;
        }
        const key = taskKey(task);
        if (task.queued || task.cursor !== null || task.from !== undefined)
          yield* sql`DELETE FROM pr_hub_sync_tasks WHERE provider_kind = 'github' AND host = ${account.host} AND viewer_id = ${account.viewerId} AND kind = 'search' AND task_key = ${key}`;
        const enqueue = (
          next: SearchTask,
        ) => sql`INSERT INTO pr_hub_sync_tasks(provider_kind, host, viewer_id, kind, task_key, payload_json, created_at, updated_at)
        VALUES ('github', ${account.host}, ${account.viewerId}, 'search', ${taskKey(next)}, ${JSON.stringify(next)}, ${timestamp}, ${timestamp})
        ON CONFLICT(provider_kind, host, viewer_id, kind, task_key) DO NOTHING`;
        if (typeof connection.issueCount === "number" && connection.issueCount >= 1000) {
          let from = task.from ?? 0;
          let to = task.to ?? now;
          let startPartition = true;
          if (task.from === undefined) {
            const roots = yield* sql<{
              payload_json: string;
            }>`SELECT payload_json FROM pr_hub_sync_tasks WHERE provider_kind = 'github' AND host = ${account.host} AND viewer_id = ${account.viewerId} AND kind = 'search_scope' AND task_key = ${key}`;
            const root = roots[0]
              ? (JSON.parse(roots[0].payload_json) as { from: number; to: number })
              : null;
            const pending = yield* sql<{
              count: number;
            }>`SELECT count(*) AS count FROM pr_hub_sync_tasks WHERE provider_kind = 'github' AND host = ${account.host} AND viewer_id = ${account.viewerId} AND kind = 'search' AND json_extract(payload_json, '$.alias') = ${task.alias}`;
            startPartition =
              root === null || (now - root.to >= 6 * 60 * 60_000 && pending[0]!.count === 0);
            if (root && !startPartition) {
              from = root.from;
              to = root.to;
            }
            if (startPartition)
              yield* sql`INSERT INTO pr_hub_sync_tasks(provider_kind, host, viewer_id, kind, task_key, payload_json, created_at, updated_at)
              VALUES ('github', ${account.host}, ${account.viewerId}, 'search_scope', ${key}, ${JSON.stringify({ from, to })}, ${timestamp}, ${timestamp})
              ON CONFLICT(provider_kind, host, viewer_id, kind, task_key) DO UPDATE SET payload_json = excluded.payload_json, updated_at = excluded.updated_at`;
          }
          if (!startPartition) return;
          if (to - from > 1000) {
            const middle = Math.floor((from + to) / 2000) * 1000;
            yield* enqueue({ ...task, cursor: null, from, to: middle });
            yield* enqueue({ ...task, cursor: null, from: middle, to });
          } else {
            // Repo-qualified scopes can escape the search cap by enumerating PRs directly.
            // Global leaves have no equivalent authoritative repository traversal.
            yield* enqueue(
              /(?:^|\s)repo:[^\s]+/.test(task.query)
                ? { ...task, cursor: null, queued: true, enumerateRepository: true }
                : task,
            );
          }
        } else if (page?.hasNextPage === true && typeof page.endCursor === "string") {
          yield* enqueue({ ...task, cursor: page.endCursor });
        }
      }),
    );
    if (task.sourceKey) {
      const pending = yield* sql<{ count: number }>`SELECT count(*) AS count FROM pr_hub_sync_tasks
        WHERE provider_kind = 'github' AND host = ${account.host} AND viewer_id = ${account.viewerId}
          AND kind = 'search' AND json_extract(payload_json, '$.sourceKey') = ${task.sourceKey}`;
      if (pending[0]?.count === 0 && page?.hasNextPage === false) {
        yield* sql`UPDATE pr_hub_sync_tasks SET payload_json = json_set(payload_json,
          '$.watermark', ${task.intervalEnd ?? now}, '$.complete', json('true'),
          '$.repairedAt', CASE WHEN json_extract(payload_json, '$.repair') = 1 THEN ${task.intervalEnd ?? now} ELSE json_extract(payload_json, '$.repairedAt') END),
          updated_at = ${timestamp}
          WHERE provider_kind = 'github' AND host = ${account.host} AND viewer_id = ${account.viewerId}
            AND kind = 'source_watermark' AND task_key = ${task.sourceKey}`;
      }
    }
    return {
      partial:
        page?.hasNextPage === true ||
        (typeof connection.issueCount === "number" && connection.issueCount > nodes.length),
      saturated: typeof connection.issueCount === "number" && connection.issueCount >= 1000,
    };
  });
}

export function resumePrHubSearch(
  account: DiscoveryAccount,
  excluded: ReadonlySet<string>,
  query: (
    document: string,
    variables: Record<string, string | null>,
  ) => Effect.Effect<unknown, SourceControlProviderError>,
) {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const tasks = yield* sql<{ payload_json: string }>`SELECT payload_json FROM pr_hub_sync_tasks
      WHERE provider_kind = 'github' AND host = ${account.host} AND viewer_id = ${account.viewerId} AND kind = 'search'
      ORDER BY created_at, task_key LIMIT 19`;
    for (const row of tasks) {
      const task = JSON.parse(row.payload_json) as SearchTask;
      const repository = task.query.match(/(?:^|\s)repo:([^\s]+)/)?.[1];
      if (repository && excluded.has(repository.toLowerCase())) {
        yield* sql`DELETE FROM pr_hub_sync_tasks WHERE provider_kind = 'github' AND host = ${account.host} AND viewer_id = ${account.viewerId} AND kind = 'search' AND task_key = ${taskKey(task)}`;
        continue;
      }

      if (task.enumerateRepository && repository) {
        yield* enumeratePrHubRepository(account, task, repository, excluded, query);
        continue;
      }

      const bounds =
        task.from === undefined || task.to === undefined
          ? ""
          : ` created:${new Date(task.from).toISOString()}..${new Date(task.to).toISOString()}`;
      const response = yield* query(PR_HUB_CONTINUATION_QUERY, {
        query: task.query + bounds,
        cursor: task.cursor,
      });
      const result = record(record(response)?.data)?.result;
      if (!record(result)) break;
      yield* ingestPrHubSearch(account, task, result, excluded);
    }
  });
}

const RELATIONSHIP_CONNECTION_FIELDS = {
  assignees: "login id",
  participants: "login id",
  reviewRequests: "id requestedReviewer { ... on User { login } ... on Team { combinedSlug } }",
} as const;
const PR_HUB_ENUMERATION_QUERY = `query PrHubRepositoryPullRequests($owner:String!,$name:String!,$cursor:String){
  repository(owner:$owner,name:$name){ pullRequests(first:20,after:$cursor,states:[OPEN],orderBy:{field:CREATED_AT,direction:ASC}) {
    nodes { id updatedAt headRefOid baseRefOid baseRefName repository { nameWithOwner } author { login }
      assignees(first:100) { totalCount nodes { ${RELATIONSHIP_CONNECTION_FIELDS.assignees} } pageInfo { hasNextPage endCursor } }
      participants(first:100) { totalCount nodes { ${RELATIONSHIP_CONNECTION_FIELDS.participants} } pageInfo { hasNextPage endCursor } }
      reviewRequests(first:100) { totalCount nodes { ${RELATIONSHIP_CONNECTION_FIELDS.reviewRequests} } pageInfo { hasNextPage endCursor } }
    } pageInfo { hasNextPage endCursor }
  } }
  rateLimit { cost remaining limit resetAt }
}`;

/** Provider relationship facts determine relevance; the saturated search's alias is never inherited. */
function enumeratePrHubRepository(
  account: DiscoveryAccount,
  task: SearchTask,
  repository: string,
  excluded: ReadonlySet<string>,
  query: (
    document: string,
    variables: Record<string, string | null>,
  ) => Effect.Effect<unknown, SourceControlProviderError>,
) {
  return Effect.gen(function* () {
    if (!account.viewerLogin)
      return yield* new SourceControlProviderError({
        provider: "github",
        operation: "prHub.enumerate",
        kind: "unauthenticated",
        detail: "Repository enumeration requires a verified viewer.",
      });
    const [owner, name] = repository.split("/");
    const response = yield* query(PR_HUB_ENUMERATION_QUERY, {
      owner: owner!,
      name: name!,
      cursor: task.cursor,
    });
    const connection = record(record(record(record(response)?.data)?.repository)?.pullRequests);
    if (!Array.isArray(connection?.nodes))
      return yield* new SourceControlProviderError({
        provider: "github",
        operation: "prHub.enumerate",
        kind: "invalid_response",
        detail: "Repository PR enumeration returned incomplete data.",
      });
    const login = account.viewerLogin.toLowerCase();
    const teams = new Set(account.viewerTeams?.map((team) => team.toLowerCase()));
    let incomplete = false;
    for (const raw of connection.nodes) {
      const node = record(raw);
      if (!node) {
        incomplete = true;
        continue;
      }
      const continued = yield* continuePrConnectionPagination(
        account,
        node,
        (document, variables) =>
          query(document, { id: String(variables.id), cursor: String(variables.cursor) }),
        RELATIONSHIP_CONNECTION_FIELDS,
        "relationship_page",
      );
      incomplete ||= !continued.complete;
      const aliases = new Set<string>();
      if (String(record(node.author)?.login ?? "").toLowerCase() === login) aliases.add("author");
      for (const field of ["assignees", "participants", "reviewRequests"] as const) {
        const facts = record(continued.node[field]);
        if (!Array.isArray(facts?.nodes)) incomplete = true;
        for (const value of Array.isArray(facts?.nodes) ? facts.nodes : []) {
          const fact =
            field === "reviewRequests" ? record(record(value)?.requestedReviewer) : record(value);
          if (String(fact?.login ?? "").toLowerCase() === login)
            aliases.add(
              field === "assignees"
                ? "assignee"
                : field === "participants"
                  ? "involved"
                  : "review_requested",
            );
          if (
            field === "reviewRequests" &&
            teams.has(String(fact?.combinedSlug ?? "").toLowerCase())
          )
            aliases.add("team_review");
        }
      }
      for (const alias of aliases)
        yield* ingestPrHubSearch(
          account,
          { alias, query: "repository-evidence", cursor: null },
          {
            nodes: [node],
            issueCount: 1,
            pageInfo: { hasNextPage: false, endCursor: null },
          },
          excluded,
        );
    }
    if (incomplete)
      return yield* new SourceControlProviderError({
        provider: "github",
        operation: "prHub.enumerate",
        kind: "invalid_response",
        detail:
          "Repository relationship facts are incomplete. Verified matches were queued; coverage remains partial.",
      });
    // Checkpoint the provider page only after its relationship evidence has been ingested.
    yield* ingestPrHubSearch(
      account,
      { ...task, queued: true },
      { nodes: [], pageInfo: connection.pageInfo },
      excluded,
    );
  });
}

export function selectPrHubHydration(
  account: DiscoveryAccount,
  excluded: ReadonlySet<string>,
  now = Date.now(),
) {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const budgets = yield* sql<{
          payload_json: string;
        }>`SELECT payload_json FROM pr_hub_sync_tasks WHERE provider_kind = 'github' AND host = ${account.host} AND viewer_id = ${account.viewerId} AND kind = 'budget' AND task_key = 'hydration'`;
        const previous = budgets[0]
          ? (JSON.parse(budgets[0].payload_json) as { start: number; used: number })
          : null;
        const budget =
          previous && now - previous.start < 180_000 ? previous : { start: now, used: 0 };
        const available = Math.max(0, 80 - budget.used);
        for (const repository of excluded)
          yield* sql`DELETE FROM pr_hub_sync_tasks WHERE provider_kind = 'github' AND host = ${account.host} AND viewer_id = ${account.viewerId} AND kind = 'hydrate' AND lower(json_extract(payload_json, '$.repository')) = ${repository}`;
        const selected = new Map<string, HydrationTask>();
        // The oldest twenty always progress even if active PRs change every poll.
        for (const [order, limit] of [
          ["created_at ASC", 20],
          ["COALESCE(json_extract(payload_json, '$.priority'), 0) DESC, updated_at DESC", 80],
        ] as const) {
          const rows = yield* sql.unsafe<{ payload_json: string }>(
            `SELECT payload_json FROM pr_hub_sync_tasks WHERE provider_kind = 'github' AND host = ? AND viewer_id = ? AND kind = 'hydrate' ORDER BY ${order}, task_key LIMIT ?`,
            [account.host, account.viewerId, limit],
          );
          for (const row of rows) {
            const task = JSON.parse(row.payload_json) as HydrationTask;
            if (task.repository && excluded.has(task.repository.toLowerCase())) continue;
            if (selected.size < available) selected.set(task.nodeId, task);
          }
        }
        const timestamp = new Date(now).toISOString();
        yield* sql`INSERT INTO pr_hub_sync_tasks(provider_kind, host, viewer_id, kind, task_key, payload_json, created_at, updated_at)
      VALUES ('github', ${account.host}, ${account.viewerId}, 'budget', 'hydration', ${JSON.stringify({ start: budget.start, used: budget.used + selected.size })}, ${timestamp}, ${timestamp})
      ON CONFLICT(provider_kind, host, viewer_id, kind, task_key) DO UPDATE SET payload_json = excluded.payload_json, updated_at = excluded.updated_at`;
        return selected;
      }),
    );
  });
}

export function finishPrHubHydration(account: DiscoveryAccount, nodeIds: readonly string[]) {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    for (const nodeId of nodeIds)
      yield* sql`DELETE FROM pr_hub_sync_tasks WHERE provider_kind = 'github' AND host = ${account.host} AND viewer_id = ${account.viewerId} AND kind = 'hydrate' AND task_key = ${nodeId}`;
  });
}

export const PR_HUB_REPOSITORIES_QUERY = `query PrHubRepositories($cursor:String){
  viewer { repositories(first:100,after:$cursor,affiliations:[OWNER,COLLABORATOR,ORGANIZATION_MEMBER],orderBy:{field:UPDATED_AT,direction:DESC}) {
    nodes { nameWithOwner isArchived } pageInfo { hasNextPage endCursor }
  } }
  rateLimit { cost remaining limit resetAt }
}`;

export function syncPrHubRepositories(
  account: DiscoveryAccount,
  configured: readonly string[],
  relationshipQueries: readonly { alias: string; query: string }[],
  excluded: ReadonlySet<string>,
  query: (
    document: string,
    variables: Record<string, string | null>,
  ) => Effect.Effect<unknown, SourceControlProviderError>,
  now = Date.now(),
) {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const timestamp = new Date(now).toISOString();
    const scopes = yield* sql<{
      payload_json: string;
    }>`SELECT payload_json FROM pr_hub_sync_tasks WHERE provider_kind = 'github' AND host = ${account.host} AND viewer_id = ${account.viewerId} AND kind = 'repositories_scope' AND task_key = 'affiliation'`;
    const scope = scopes[0]
      ? (JSON.parse(scopes[0].payload_json) as {
          cursor: string | null;
          nextCheckAt: number;
          complete: boolean;
          members?: string[];
        })
      : null;
    const repositories = new Map(configured.map((name) => [name, false]));
    let nextScope = scope;
    let membershipChanged = false;
    if (!scope || scope.nextCheckAt <= now) {
      const response = yield* query(PR_HUB_REPOSITORIES_QUERY, { cursor: scope?.cursor ?? null });
      const connection = record(record(record(response)?.data)?.viewer)?.repositories;
      const collection = record(connection);
      const page = record(collection?.pageInfo);
      if (
        !Array.isArray(collection?.nodes) ||
        typeof page?.hasNextPage !== "boolean" ||
        (page.hasNextPage && typeof page.endCursor !== "string")
      )
        return yield* new SourceControlProviderError({
          provider: "github",
          operation: "prHub.repositories",
          kind: "invalid_response",
          detail: "Repository affiliation traversal returned incomplete data.",
        });
      for (const raw of collection.nodes) {
        const repository = record(raw);
        const name = string(repository?.nameWithOwner);
        if (name) repositories.set(name, repository?.isArchived === true);
      }
      nextScope = {
        cursor: page.hasNextPage ? string(page.endCursor) : null,
        complete: !page.hasNextPage,
        nextCheckAt: page.hasNextPage ? now : now + 15 * 60_000,
        members: [
          ...new Set([...(scope?.cursor ? (scope.members ?? []) : []), ...repositories.keys()]),
        ],
      };
      if (nextScope.complete) {
        membershipChanged = (yield* recordPrHubMembership(
          account,
          "repositories",
          nextScope.members!,
        )).changed;
      }
    }
    yield* sql.withTransaction(
      Effect.gen(function* () {
        for (const [name, archived] of repositories) {
          if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(name) || excluded.has(name.toLowerCase()))
            continue;
          const previous = yield* sql<{
            payload_json: string;
          }>`SELECT payload_json FROM pr_hub_sync_tasks WHERE provider_kind = 'github' AND host = ${account.host} AND viewer_id = ${account.viewerId} AND kind = 'known_repository' AND task_key = ${name}`;
          const previousData = previous[0]
            ? (JSON.parse(previous[0].payload_json) as { searchedAt: number })
            : null;
          const due = !previousData || now - previousData.searchedAt >= 15 * 60_000;
          if (due && !archived)
            for (const relationship of relationshipQueries) {
              const scope = yield* beginPrHubSearch(
                account,
                relationship.alias,
                `${relationship.query} repo:${name}`,
                now,
              );
              const task: SearchTask = { ...scope, queued: true };
              yield* sql`INSERT OR IGNORE INTO pr_hub_sync_tasks(provider_kind, host, viewer_id, kind, task_key, payload_json, created_at, updated_at)
            VALUES ('github', ${account.host}, ${account.viewerId}, 'search', ${taskKey(task)}, ${JSON.stringify(task)}, ${timestamp}, ${timestamp})`;
            }
          yield* sql`INSERT INTO pr_hub_sync_tasks(provider_kind, host, viewer_id, kind, task_key, payload_json, created_at, updated_at)
          VALUES ('github', ${account.host}, ${account.viewerId}, 'known_repository', ${name}, ${JSON.stringify({ archived, searchedAt: due ? now : (previousData?.searchedAt ?? now) })}, ${timestamp}, ${timestamp})
          ON CONFLICT(provider_kind, host, viewer_id, kind, task_key) DO UPDATE SET payload_json = excluded.payload_json, updated_at = excluded.updated_at`;
        }
        if (nextScope)
          yield* sql`INSERT INTO pr_hub_sync_tasks(provider_kind, host, viewer_id, kind, task_key, payload_json, created_at, updated_at)
        VALUES ('github', ${account.host}, ${account.viewerId}, 'repositories_scope', 'affiliation', ${JSON.stringify(nextScope)}, ${timestamp}, ${timestamp})
        ON CONFLICT(provider_kind, host, viewer_id, kind, task_key) DO UPDATE SET payload_json = excluded.payload_json, updated_at = excluded.updated_at`;
      }),
    );
    return !membershipChanged && (nextScope?.complete ?? false);
  });
}

/** Previously tracked open PRs enter the same fair hydration queue independently of search. */
export function enqueuePrHubTracked(
  account: DiscoveryAccount,
  excluded: ReadonlySet<string>,
  now = Date.now(),
) {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const timestamp = new Date(now).toISOString();
    const before = new Date(now - 180_000).toISOString();
    yield* sql`INSERT INTO pr_hub_sync_tasks(provider_kind, host, viewer_id, kind, task_key, payload_json, created_at, updated_at)
      SELECT p.provider_kind, p.host, v.viewer_id, 'hydrate', p.node_id,
        json_object('nodeId', p.node_id, 'aliases', json_array('involved'), 'repository', p.repo, 'updatedAt', p.updated_at, 'priority', CASE WHEN v.attention_bucket = 'needs_you' THEN 2 ELSE 0 END),
        COALESCE(json_extract(v.viewer_payload_json, '$.lastVerifiedAt'), p.created_at), p.updated_at
      FROM pr_hub_prs p JOIN pr_hub_viewer_state v ON v.provider_kind = p.provider_kind AND v.host = p.host AND v.repo = p.repo AND v.number = p.number
      WHERE p.provider_kind = 'github' AND p.host = ${account.host} AND v.viewer_id = ${account.viewerId}
        AND p.state = 'open' AND p.node_id IS NOT NULL
        AND (json_extract(v.viewer_payload_json, '$.lastVerifiedAt') IS NULL OR json_extract(v.viewer_payload_json, '$.lastVerifiedAt') <= ${before})
        AND lower(p.repo) NOT IN (SELECT value FROM json_each(${JSON.stringify([...excluded])}))
      ON CONFLICT(provider_kind, host, viewer_id, kind, task_key) DO UPDATE SET payload_json = json_set(pr_hub_sync_tasks.payload_json,
        '$.priority', max(COALESCE(json_extract(pr_hub_sync_tasks.payload_json, '$.priority'), 0), json_extract(excluded.payload_json, '$.priority')))`;
    return timestamp;
  });
}
