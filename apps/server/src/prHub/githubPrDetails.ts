import type {
  PrHubActor,
  PrHubChangedFile,
  PrHubCheck,
  PrHubDetail,
  PrHubFileChangeType,
  PrHubReaction,
  PrHubReactionContent,
  PrHubReviewer,
  PrHubTimelineEntry,
  SourceControlPageInfo,
  SourceControlRateLimit,
  TrackedPullRequest,
} from "@t3tools/contracts";

export const GITHUB_PR_DETAIL_QUERY = `
query F5PrDetail($owner:String!,$repo:String!,$number:Int!){
  repository(owner:$owner,name:$repo){
    pullRequest(number:$number){
      id title body url state isDraft mergeable mergeStateStatus
      additions deletions changedFiles headRefName baseRefName headRefOid baseRefOid
      createdAt updatedAt mergedAt closedAt viewerCanUpdate viewerDidAuthor
      author { login avatarUrl ... on User { name } }
      labels(first:50){ totalCount pageInfo { hasNextPage } nodes { name color } }
      reviewRequests(first:50){ totalCount pageInfo { hasNextPage } nodes { requestedReviewer { __typename ... on User { login name avatarUrl } ... on Team { slug name avatarUrl } } } }
      latestReviews(first:50){ totalCount pageInfo { hasNextPage } nodes { author { login avatarUrl ... on User { name } } } }
      reactionGroups { content viewerHasReacted users(first:20){ totalCount nodes { login } } }
      commits(last:1){ nodes { commit { statusCheckRollup { contexts(first:100){ totalCount pageInfo { hasNextPage } nodes {
        __typename
        ... on CheckRun { name status conclusion detailsUrl }
        ... on StatusContext { context state description targetUrl }
      } } } } } }
    }
  }
  rateLimit { remaining limit resetAt }
}`;

export const GITHUB_PR_TIMELINE_QUERY = `
query F5PrTimeline($owner:String!,$repo:String!,$number:Int!,$issueLimit:Int!,$issueCursor:String,$reviewLimit:Int!,$reviewCursor:String,$commitLimit:Int!,$commitCursor:String){
  repository(owner:$owner,name:$repo){
    pullRequest(number:$number){
      comments(last:$issueLimit,before:$issueCursor){
        nodes { id databaseId body createdAt updatedAt url viewerDidAuthor author { login avatarUrl ... on User { name } } reactionGroups { content viewerHasReacted users(first:20){ totalCount nodes { login } } } }
        pageInfo { hasPreviousPage startCursor }
      }
      reviews(last:$reviewLimit,before:$reviewCursor){
        nodes {
          id body state submittedAt url author { login avatarUrl ... on User { name } }
          comments(first:25){ totalCount nodes { id databaseId body createdAt updatedAt url path line originalLine viewerDidAuthor author { login avatarUrl ... on User { name } } reactionGroups { content viewerHasReacted users(first:20){ totalCount nodes { login } } } } }
        }
        pageInfo { hasPreviousPage startCursor }
      }
      commits(last:$commitLimit,before:$commitCursor){
        nodes { commit { oid messageHeadline committedDate authors(first:10){ nodes { name user { login avatarUrl } } } } }
        pageInfo { hasPreviousPage startCursor }
      }
    }
  }
  rateLimit { remaining limit resetAt }
}`;

export const GITHUB_PR_FILES_QUERY = `
query F5PrFiles($owner:String!,$repo:String!,$number:Int!,$cursor:String){
  repository(owner:$owner,name:$repo){
    pullRequest(number:$number){
      files(first:50,after:$cursor){
        nodes { path additions deletions changeType }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
  rateLimit { remaining limit resetAt }
}`;

export const GITHUB_ADD_REACTION_MUTATION = `
mutation F5AddReaction($subjectId:ID!,$content:ReactionContent!){
  addReaction(input:{subjectId:$subjectId,content:$content}){ reaction { content } subject { id } }
}`;

export const GITHUB_REMOVE_REACTION_MUTATION = `
mutation F5RemoveReaction($subjectId:ID!,$content:ReactionContent!){
  removeReaction(input:{subjectId:$subjectId,content:$content}){ reaction { content } subject { id } }
}`;

type UnknownRecord = Record<string, unknown>;

interface TimelineCursorState {
  readonly issueBefore: string | null;
  readonly reviewBefore: string | null;
  readonly commitBefore: string | null;
  readonly issueDone: boolean;
  readonly reviewDone: boolean;
  readonly commitDone: boolean;
}

function asRecord(value: unknown, label: string): UnknownRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`GitHub returned an invalid ${label}.`);
  }
  return value as UnknownRecord;
}

function recordOrNull(value: unknown): UnknownRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null;
}

function nodesOf(value: unknown): ReadonlyArray<UnknownRecord> {
  const record = recordOrNull(value);
  const nodes = record?.nodes;
  return Array.isArray(nodes) ? nodes.map(recordOrNull).filter((node) => node !== null) : [];
}

function connectionIsTruncated(value: unknown): boolean {
  const connection = recordOrNull(value);
  if (!connection) return false;
  const pageInfo = recordOrNull(connection.pageInfo);
  if (pageInfo?.hasNextPage === true) return true;
  return nonNegativeInt(connection.totalCount) > nodesOf(connection).length;
}

function stringOf(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function nonNegativeInt(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : fallback;
}

function actorOf(value: unknown): PrHubActor | null {
  const actor = recordOrNull(value);
  if (!actor) return null;
  const login = nullableString(actor.login) ?? nullableString(actor.slug);
  if (!login) return null;
  return {
    login,
    name: nullableString(actor.name),
    avatarUrl: nullableString(actor.avatarUrl),
  };
}

const REACTION_FROM_GITHUB: Readonly<Record<string, PrHubReactionContent | undefined>> = {
  THUMBS_UP: "+1",
  THUMBS_DOWN: "-1",
  LAUGH: "laugh",
  HOORAY: "hooray",
  CONFUSED: "confused",
  HEART: "heart",
  ROCKET: "rocket",
  EYES: "eyes",
};

export const GITHUB_REACTION_CONTENT: Readonly<Record<PrHubReactionContent, string>> = {
  "+1": "THUMBS_UP",
  "-1": "THUMBS_DOWN",
  laugh: "LAUGH",
  hooray: "HOORAY",
  confused: "CONFUSED",
  heart: "HEART",
  rocket: "ROCKET",
  eyes: "EYES",
};

function reactionsOf(value: unknown): ReadonlyArray<PrHubReaction> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((raw): ReadonlyArray<PrHubReaction> => {
    const group = recordOrNull(raw);
    const content = group ? REACTION_FROM_GITHUB[stringOf(group.content)] : undefined;
    if (!group || !content) return [];
    const users = recordOrNull(group.users);
    return [
      {
        content,
        count: nonNegativeInt(users?.totalCount),
        viewerHasReacted: group.viewerHasReacted === true,
        actors: nodesOf(users)
          .map((actor) => stringOf(actor.login))
          .filter(Boolean),
      },
    ];
  });
}

function stateOf(value: unknown): PrHubDetail["state"] {
  switch (stringOf(value).toUpperCase()) {
    case "MERGED":
      return "merged";
    case "CLOSED":
      return "closed";
    default:
      return "open";
  }
}

function mergeableOf(value: unknown): PrHubDetail["mergeable"] {
  switch (stringOf(value).toUpperCase()) {
    case "MERGEABLE":
      return "mergeable";
    case "CONFLICTING":
      return "conflicting";
    default:
      return "unknown";
  }
}

function checkOf(value: UnknownRecord): PrHubCheck | null {
  if (value.__typename === "CheckRun") {
    const conclusion = stringOf(value.conclusion).toUpperCase();
    const status = stringOf(value.status).toUpperCase();
    const normalized: PrHubCheck["status"] =
      status !== "COMPLETED"
        ? "pending"
        : conclusion === "SUCCESS"
          ? "success"
          : conclusion === "NEUTRAL"
            ? "neutral"
            : conclusion === "CANCELLED"
              ? "cancelled"
              : conclusion === "SKIPPED"
                ? "skipped"
                : "failure";
    return {
      name: stringOf(value.name, "Check"),
      status: normalized,
      description: nullableString(value.conclusion),
      url: nullableString(value.detailsUrl),
    };
  }
  if (value.__typename === "StatusContext") {
    const state = stringOf(value.state).toUpperCase();
    return {
      name: stringOf(value.context, "Status"),
      status:
        state === "SUCCESS"
          ? "success"
          : state === "PENDING" || state === "EXPECTED"
            ? "pending"
            : state === "ERROR" || state === "FAILURE"
              ? "failure"
              : "neutral",
      description: nullableString(value.description),
      url: nullableString(value.targetUrl),
    };
  }
  return null;
}

function rateLimitOf(root: UnknownRecord): SourceControlRateLimit | undefined {
  const rate = recordOrNull(root.rateLimit);
  if (!rate) return undefined;
  return {
    remaining: nonNegativeInt(rate.remaining),
    limit: nonNegativeInt(rate.limit),
    resetAt: nullableString(rate.resetAt),
  };
}

function pullRequestOf(response: unknown): {
  readonly root: UnknownRecord;
  readonly pr: UnknownRecord;
} {
  const root = asRecord(response, "GraphQL response");
  if (Array.isArray(root.errors) && root.errors.length > 0) {
    throw new Error("GitHub returned GraphQL errors; pull request details are incomplete.");
  }
  const data = asRecord(root.data, "GraphQL data");
  const repository = asRecord(data.repository, "repository");
  const pr = asRecord(repository.pullRequest, "pull request");
  return { root: data, pr };
}

export function decodeGitHubPrDetail(
  response: unknown,
  tracked: TrackedPullRequest,
): { readonly detail: PrHubDetail; readonly rateLimit?: SourceControlRateLimit } {
  const { root, pr } = pullRequestOf(response);
  const requested = nodesOf(pr.reviewRequests).flatMap((request): ReadonlyArray<PrHubReviewer> => {
    const reviewer = actorOf(request.requestedReviewer);
    if (!reviewer) return [];
    const requestedReviewer = recordOrNull(request.requestedReviewer);
    return [
      {
        ...reviewer,
        kind: requestedReviewer?.__typename === "Team" ? "team" : "user",
        requested: true,
      },
    ];
  });
  const completed = nodesOf(pr.latestReviews).flatMap((review): ReadonlyArray<PrHubReviewer> => {
    const reviewer = actorOf(review.author);
    return reviewer ? [{ ...reviewer, kind: "user", requested: false }] : [];
  });
  const reviewersByLogin = new Map<string, PrHubReviewer>();
  for (const reviewer of [...completed, ...requested]) {
    reviewersByLogin.set(`${reviewer.kind}:${reviewer.login.toLowerCase()}`, reviewer);
  }

  const latestCommit = nodesOf(pr.commits)[0];
  const commit = recordOrNull(latestCommit?.commit);
  const statusRollup = recordOrNull(commit?.statusCheckRollup);
  const contexts = recordOrNull(statusRollup?.contexts);
  const checks = nodesOf(contexts)
    .map(checkOf)
    .filter((check) => check !== null);
  const truncatedSections: Array<"labels" | "reviewers" | "checks"> = [];
  if (connectionIsTruncated(pr.labels)) truncatedSections.push("labels");
  if (connectionIsTruncated(pr.reviewRequests) || connectionIsTruncated(pr.latestReviews)) {
    truncatedSections.push("reviewers");
  }
  if (connectionIsTruncated(contexts)) truncatedSections.push("checks");

  const detail: PrHubDetail = {
    key: tracked.key,
    providerDetails: {
      provider: "github",
      nodeId: nullableString(pr.id) ?? tracked.nodeId,
      mergeStateStatus: stringOf(pr.mergeStateStatus, tracked.mergeStateStatus),
      headRefOid: nullableString(pr.headRefOid) ?? tracked.headRefOid,
      baseRefOid: nullableString(pr.baseRefOid),
      viewerCanUpdate: pr.viewerCanUpdate === true,
      viewerDidAuthor: pr.viewerDidAuthor === true,
    },
    title: stringOf(pr.title, tracked.title),
    body: stringOf(pr.body),
    url: stringOf(pr.url, tracked.url),
    state: stateOf(pr.state),
    isDraft: typeof pr.isDraft === "boolean" ? pr.isDraft : tracked.isDraft,
    mergeable: mergeableOf(pr.mergeable),
    additions: nonNegativeInt(pr.additions, tracked.additions),
    deletions: nonNegativeInt(pr.deletions, tracked.deletions),
    changedFiles: nonNegativeInt(pr.changedFiles, tracked.changedFiles),
    headRefName: nullableString(pr.headRefName) ?? tracked.headRefName,
    baseRefName: nullableString(pr.baseRefName) ?? tracked.baseRefName,
    createdAt: stringOf(pr.createdAt, tracked.createdAt),
    updatedAt: stringOf(pr.updatedAt, tracked.updatedAt),
    mergedAt: nullableString(pr.mergedAt),
    closedAt: nullableString(pr.closedAt),
    author: actorOf(pr.author),
    labels: nodesOf(pr.labels).map((label) => ({
      name: stringOf(label.name),
      color: nullableString(label.color),
    })),
    reviewers: [...reviewersByLogin.values()],
    checks,
    reactions: reactionsOf(pr.reactionGroups),
    ...(truncatedSections.length > 0 ? { truncatedSections } : {}),
  };
  const rateLimit = rateLimitOf(root);
  return { detail, ...(rateLimit ? { rateLimit } : {}) };
}

function decodeTimelineCursor(cursor: string | undefined): TimelineCursorState {
  if (!cursor) {
    return {
      issueBefore: null,
      reviewBefore: null,
      commitBefore: null,
      issueDone: false,
      reviewDone: false,
      commitDone: false,
    };
  }
  if (cursor.length > 4096) throw new Error("The PR timeline cursor is too long.");
  const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown;
  const value = asRecord(parsed, "timeline cursor");
  const cursorValue = (entry: unknown) => (entry === null ? null : nullableString(entry));
  const issueBefore = cursorValue(value.issueBefore);
  const reviewBefore = cursorValue(value.reviewBefore);
  const commitBefore = cursorValue(value.commitBefore);
  const isBoolean = (entry: unknown): entry is boolean => entry === true || entry === false;
  if (!isBoolean(value.issueDone) || !isBoolean(value.reviewDone) || !isBoolean(value.commitDone)) {
    throw new Error("The PR timeline cursor is invalid.");
  }
  return {
    issueBefore,
    reviewBefore,
    commitBefore,
    issueDone: value.issueDone === true,
    reviewDone: value.reviewDone === true,
    commitDone: value.commitDone === true,
  };
}

function encodeTimelineCursor(cursor: TimelineCursorState): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function connectionPageInfo(value: unknown): {
  readonly hasPreviousPage: boolean;
  readonly startCursor: string | null;
} {
  const connection = recordOrNull(value);
  const pageInfo = recordOrNull(connection?.pageInfo);
  return {
    hasPreviousPage: pageInfo?.hasPreviousPage === true,
    startCursor: nullableString(pageInfo?.startCursor),
  };
}

function timelineTimestamp(entry: PrHubTimelineEntry): string {
  return entry.type === "commit" ? entry.committedAt : entry.createdAt;
}

export function githubTimelineVariables(input: {
  readonly owner: string;
  readonly repo: string;
  readonly number: number;
  readonly cursor?: string | undefined;
}): Readonly<Record<string, string | number>> {
  const cursor = decodeTimelineCursor(input.cursor);
  return {
    owner: input.owner,
    repo: input.repo,
    number: input.number,
    issueLimit: cursor.issueDone ? 1 : 25,
    reviewLimit: cursor.reviewDone ? 1 : 25,
    commitLimit: cursor.commitDone ? 1 : 25,
    ...(cursor.issueBefore ? { issueCursor: cursor.issueBefore } : {}),
    ...(cursor.reviewBefore ? { reviewCursor: cursor.reviewBefore } : {}),
    ...(cursor.commitBefore ? { commitCursor: cursor.commitBefore } : {}),
  };
}

export function decodeGitHubPrTimeline(
  response: unknown,
  inputCursor?: string | undefined,
): {
  readonly entries: ReadonlyArray<PrHubTimelineEntry>;
  readonly pageInfo: SourceControlPageInfo;
} {
  const previous = decodeTimelineCursor(inputCursor);
  const { root, pr } = pullRequestOf(response);
  const issueComments = recordOrNull(pr.comments);
  const reviews = recordOrNull(pr.reviews);
  const commits = recordOrNull(pr.commits);
  const entries: PrHubTimelineEntry[] = [];

  if (!previous.issueDone) {
    for (const comment of nodesOf(issueComments)) {
      entries.push({
        type: "comment",
        id: stringOf(comment.id),
        databaseId:
          typeof comment.databaseId === "number"
            ? String(comment.databaseId)
            : nullableString(comment.databaseId),
        kind: "issue-comment",
        author: actorOf(comment.author),
        body: stringOf(comment.body),
        createdAt: stringOf(comment.createdAt),
        updatedAt: nullableString(comment.updatedAt),
        url: nullableString(comment.url),
        path: null,
        line: null,
        reviewState: null,
        viewerCanUpdate: comment.viewerDidAuthor === true,
        reactions: reactionsOf(comment.reactionGroups),
      });
    }
  }

  if (!previous.reviewDone) {
    for (const review of nodesOf(reviews)) {
      const submittedAt = stringOf(review.submittedAt);
      entries.push({
        type: "comment",
        id: stringOf(review.id),
        databaseId: null,
        kind: "review",
        author: actorOf(review.author),
        body: stringOf(review.body),
        createdAt: submittedAt,
        updatedAt: null,
        url: nullableString(review.url),
        path: null,
        line: null,
        reviewState: nullableString(review.state),
        viewerCanUpdate: false,
        reactions: [],
      });
      const reviewComments = recordOrNull(review.comments);
      for (const comment of nodesOf(reviewComments)) {
        entries.push({
          type: "comment",
          id: stringOf(comment.id),
          databaseId:
            typeof comment.databaseId === "number"
              ? String(comment.databaseId)
              : nullableString(comment.databaseId),
          kind: "review-comment",
          author: actorOf(comment.author),
          body: stringOf(comment.body),
          createdAt: stringOf(comment.createdAt, submittedAt),
          updatedAt: nullableString(comment.updatedAt),
          url: nullableString(comment.url),
          path: nullableString(comment.path),
          line:
            typeof comment.line === "number"
              ? nonNegativeInt(comment.line)
              : typeof comment.originalLine === "number"
                ? nonNegativeInt(comment.originalLine)
                : null,
          reviewState: nullableString(review.state),
          viewerCanUpdate: comment.viewerDidAuthor === true,
          reactions: reactionsOf(comment.reactionGroups),
        });
      }
    }
  }

  if (!previous.commitDone) {
    for (const node of nodesOf(commits)) {
      const commit = recordOrNull(node.commit);
      if (!commit) continue;
      const authors = recordOrNull(commit.authors);
      entries.push({
        type: "commit",
        id: stringOf(commit.oid),
        oid: stringOf(commit.oid),
        messageHeadline: stringOf(commit.messageHeadline),
        committedAt: stringOf(commit.committedDate),
        authors: nodesOf(authors).flatMap((author): ReadonlyArray<PrHubActor> => {
          const user = actorOf(author.user);
          if (user) return [{ ...user, name: nullableString(author.name) ?? user.name }];
          const name = nullableString(author.name);
          return name ? [{ login: name, name, avatarUrl: null }] : [];
        }),
      });
    }
  }

  const issuePage = connectionPageInfo(issueComments);
  const reviewPage = connectionPageInfo(reviews);
  const commitPage = connectionPageInfo(commits);
  const next: TimelineCursorState = {
    issueBefore: issuePage.startCursor,
    reviewBefore: reviewPage.startCursor,
    commitBefore: commitPage.startCursor,
    issueDone: previous.issueDone || !issuePage.hasPreviousPage,
    reviewDone: previous.reviewDone || !reviewPage.hasPreviousPage,
    commitDone: previous.commitDone || !commitPage.hasPreviousPage,
  };
  const hasNextPage = !next.issueDone || !next.reviewDone || !next.commitDone;
  const nestedReviewTruncated = nodesOf(reviews).some((review) => {
    const comments = recordOrNull(review.comments);
    return nonNegativeInt(comments?.totalCount) > nodesOf(comments).length;
  });
  entries.sort((left, right) => timelineTimestamp(right).localeCompare(timelineTimestamp(left)));
  const rateLimit = rateLimitOf(root);
  return {
    entries,
    pageInfo: {
      hasNextPage,
      endCursor: hasNextPage ? encodeTimelineCursor(next) : null,
      truncated: nestedReviewTruncated,
      ...(rateLimit ? { rateLimit } : {}),
    },
  };
}

function fileChangeTypeOf(value: unknown): PrHubFileChangeType {
  switch (stringOf(value).toUpperCase()) {
    case "ADDED":
      return "added";
    case "DELETED":
      return "deleted";
    case "RENAMED":
      return "renamed";
    case "COPIED":
      return "copied";
    case "CHANGED":
    case "MODIFIED":
      return "changed";
    default:
      return "unknown";
  }
}

export function decodeGitHubPrFiles(response: unknown): {
  readonly files: ReadonlyArray<PrHubChangedFile>;
  readonly pageInfo: SourceControlPageInfo;
} {
  const { root, pr } = pullRequestOf(response);
  const files = recordOrNull(pr.files);
  const pageInfo = recordOrNull(files?.pageInfo);
  const rateLimit = rateLimitOf(root);
  return {
    files: nodesOf(files).map((file) => ({
      path: stringOf(file.path),
      additions: nonNegativeInt(file.additions),
      deletions: nonNegativeInt(file.deletions),
      changeType: fileChangeTypeOf(file.changeType),
    })),
    pageInfo: {
      hasNextPage: pageInfo?.hasNextPage === true,
      endCursor: nullableString(pageInfo?.endCursor),
      truncated: false,
      ...(rateLimit ? { rateLimit } : {}),
    },
  };
}
