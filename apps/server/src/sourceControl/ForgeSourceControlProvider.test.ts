import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import {
  FORGE_CAPABILITIES,
  makeForgeSourceControlProvider,
  type ForgeKind,
} from "./ForgeSourceControlProvider.ts";

let nextAccount = 0;
function fixture(kind: ForgeKind, responses: unknown[] = [], login = `viewer-${++nextAccount}`) {
  const host =
    kind === "gitlab"
      ? "gitlab.com"
      : kind === "bitbucket"
        ? "bitbucket.org"
        : kind === "azure-devops"
          ? "dev.azure.com"
          : "codeberg.org";
  const repository = kind === "azure-devops" ? "org/project/repo" : "team/repo";
  const ref = { provider: kind, host, repository, number: 7 };
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetch = async (url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const value = responses.shift() ?? (String(url).includes("/statuses/") ? [] : {});
    return value instanceof Response
      ? value
      : new Response(typeof value === "string" ? value : JSON.stringify(value), { status: 200 });
  };
  const provider = makeForgeSourceControlProvider({
    kind,
    resolveAccount: () =>
      Effect.succeed({ kind, host, repository, login, token: "isolated-token" }),
    fetch: fetch as typeof globalThis.fetch,
  });
  return { provider, ref, calls };
}

describe("forge adapters", () => {
  it("starts the branch policy and first status page together", async () => {
    const bothStarted = Promise.withResolvers<void>();
    let starts = 0;
    let firstPageReads = 0;
    const provider = makeForgeSourceControlProvider({
      kind: "forgejo",
      resolveAccount: () =>
        Effect.succeed({
          kind: "forgejo",
          host: "codeberg.org",
          repository: "team/repo",
          login: "parallel-checks",
          token: "isolated-token",
        }),
      fetch: (async (input) => {
        const url = new URL(String(input));
        if (url.pathname.endsWith("/pulls/7"))
          return Response.json({ number: 7, base: { ref: "main" }, head: { sha: "head" } });
        const branch = url.pathname.includes("/branches/");
        const firstPage = url.searchParams.get("page") === "1";
        if (branch || firstPage) {
          if (firstPage) firstPageReads++;
          if (++starts === 2) bothStarted.resolve();
          // Neither request can finish until both have started.
          await bothStarted.promise;
        }
        return Response.json(
          branch
            ? { enable_status_check: true, status_check_contexts: ["ci"] }
            : firstPage
              ? [{ context: "ci", status: "success" }]
              : [],
        );
      }) as typeof fetch,
    });
    const detail = await Effect.runPromise(
      provider.getDetail(
        {
          provider: "forgejo",
          host: "codeberg.org",
          repository: "team/repo",
          number: 7,
        },
        { checks: true },
      ),
    );
    expect(detail.checksComplete).toBe(true);
    expect(detail.checks?.[0]).toMatchObject({ name: "ci", status: "success", required: true });
    expect(firstPageReads).toBe(1);
  });

  it("marks Forgejo required checks and preserves optional failures", async () => {
    const { provider, ref, calls } = fixture("forgejo", [
      { number: 7, base: { ref: "release/1.x" }, head: { sha: "head" } },
      { enable_status_check: true, status_check_contexts: ["ci/*", "deploy", "deploy"] },
      [
        { context: "ci/build", status: "success", target_url: "/team/repo/actions/1" },
        { context: "ci/build", status: "failure" },
        { context: "optional", status: "failure" },
      ],
    ]);
    const detail = await Effect.runPromise(provider.getDetail(ref, { checks: true }));
    expect(detail.checksComplete).toBe(true);
    expect(detail.checks?.map(({ name, status, required }) => [name, status, required])).toEqual([
      ["ci/build", "success", true],
      ["optional", "failure", undefined],
      ["deploy", "pending", true],
    ]);
    expect(detail.checks?.[0]?.url).toBe("https://codeberg.org/team/repo/actions/1");
    expect(calls[1]?.url).toContain("/branches/release/1.x");
  });

  it.each([403, 404])(
    "keeps all Forgejo checks gating without branch access (%s)",
    async (status) => {
      const { provider, ref } = fixture("forgejo", [
        { number: 7, base: { ref: "main" }, head: { sha: "head" } },
        new Response(null, { status }),
        [{ context: "optional", status: "failure" }],
      ]);
      const detail = await Effect.runPromise(provider.getDetail(ref, { checks: true }));
      expect(detail.checks?.[0]).toMatchObject({ status: "failure" });
      expect(detail.checks?.[0]?.required).toBeUndefined();
    },
  );

  it.each([401, 429])("propagates Forgejo branch failures (%s)", async (status) => {
    const { provider, ref } = fixture("forgejo", [
      { number: 7, base: { ref: "main" }, head: { sha: "head" } },
      new Response(null, { status }),
    ]);
    const result = await Effect.runPromise(
      provider.getDetail(ref, { checks: true }).pipe(Effect.result),
    );
    expect(result._tag).toBe("Failure");
  });

  it("does not accept a partial Forgejo status listing", async () => {
    const { provider, ref } = fixture("forgejo", [
      { number: 7, base: { ref: "main" }, head: { sha: "head" } },
      {},
      ...Array.from({ length: 20 }, () =>
        Array.from({ length: 50 }, () => ({ context: "ci", status: "success" })),
      ),
    ]);
    const detail = await Effect.runPromise(provider.getDetail(ref, { checks: true }));
    expect(detail.checksComplete).toBe(false);
    expect(detail.checks).toEqual([]);
  });

  it("reads server-capped pages until an empty page, including later wildcard failures", async () => {
    const { provider, ref, calls } = fixture("forgejo", [
      { number: 7, base: { ref: "main" }, head: { sha: "head" } },
      { enable_status_check: true, status_check_contexts: ["ci/*"] },
      [{ context: "ci/build", status: "success" }],
      [{ context: "ci/test", status: "failure" }],
      [],
    ]);
    const detail = await Effect.runPromise(provider.getDetail(ref, { checks: true }));
    expect(detail.checksComplete).toBe(true);
    expect(detail.checks?.map(({ name, status, required }) => [name, status, required])).toEqual([
      ["ci/build", "success", true],
      ["ci/test", "failure", true],
    ]);
    expect(calls.at(-1)?.url).toContain("page=3");
  });

  it.each([
    ["warning", "neutral"],
    ["error", "failure"],
    ["skipped", "skipped"],
    ["pending", "pending"],
    ["future-state", "pending"],
  ])("maps Forgejo %s to %s", async (status, expected) => {
    const { provider, ref } = fixture("forgejo", [
      { number: 7, base: { ref: "main" }, head: { sha: "head" } },
      { enable_status_check: true, status_check_contexts: ["ci"] },
      [{ context: "ci", status }],
      [],
    ]);
    const detail = await Effect.runPromise(provider.getDetail(ref, { checks: true }));
    expect(detail.checks?.[0]).toMatchObject({ status: expected, required: true });
  });

  it.each(["id", "index"])(
    "breaks timestamp ties by %s across pages in either arrival order",
    async (idField) => {
      for (const reverse of [false, true]) {
        const statuses = [
          { context: "ci", status: "success", [idField]: 1, updated_at: "2026-11-14T00:00:00Z" },
          { context: "ci", status: "failure", [idField]: 2, updated_at: "2026-11-14T00:00:00Z" },
          { context: "ci", status: "pending", [idField]: 3, updated_at: "2026-11-13T00:00:00Z" },
        ];
        const { provider, ref } = fixture("forgejo", [
          { number: 7, base: { ref: "main" }, head: { sha: "head" } },
          {},
          ...(reverse ? statuses.toReversed() : statuses).map((status) => [status]),
          [],
        ]);
        expect(
          (await Effect.runPromise(provider.getDetail(ref, { checks: true }))).checks?.[0]?.status,
        ).toBe("failure");
      }
    },
  );

  it.each(["branch", "statuses", "later-page"])(
    "preserves closed PR metadata on a failed %s read",
    async (stage) => {
      const responses: unknown[] = [
        {
          number: 7,
          title: "Closed",
          state: "closed",
          base: { ref: "main" },
          head: { sha: "head" },
        },
      ];
      if (stage !== "branch") responses.push({});
      if (stage === "later-page") responses.push([{ context: "ci", status: "success" }]);
      responses.push(new Response(null, { status: 503 }));
      const { provider, ref } = fixture("forgejo", responses);
      expect(await Effect.runPromise(provider.getDetail(ref, { checks: true }))).toMatchObject({
        title: "Closed",
        state: "closed",
        headRefOid: "head",
        checks: [],
        checksComplete: false,
      });
    },
  );

  it("marks a malformed status page incomplete", async () => {
    const { provider, ref } = fixture("forgejo", [
      { number: 7, base: { ref: "main" }, head: { sha: "head" } },
      {},
      { invalid: true },
    ]);
    expect(await Effect.runPromise(provider.getDetail(ref, { checks: true }))).toMatchObject({
      checks: [],
      checksComplete: false,
    });
  });

  it.each([401, 429])("propagates status page HTTP %s", async (status) => {
    const { provider, ref } = fixture("forgejo", [
      { number: 7, base: { ref: "main" }, head: { sha: "head" } },
      {},
      new Response(null, { status }),
    ]);
    const result = await Effect.runPromise(
      provider.getDetail(ref, { checks: true }).pipe(Effect.result),
    );
    expect(result._tag).toBe("Failure");
  });

  it("reads fork child pipelines on the selected GitLab host", async () => {
    const { provider, ref, calls } = fixture("gitlab", [
      {
        iid: 7,
        title: "Change",
        source_project_id: 12,
        target_project_id: 99,
        head_pipeline: {
          id: 31,
          project_id: 12,
          status: "success",
          source: "merge_request_event",
          web_url: "https://gitlab.com/fork/-/pipelines/31",
        },
      },
      { path_with_namespace: "fork/repo" },
      [
        {
          name: "deploy",
          status: "success",
          downstream_pipeline: {
            status: "failed",
            web_url: "https://gitlab.com/fork/-/pipelines/32",
          },
        },
        { name: "optional", allow_failure: true, downstream_pipeline: { status: "failed" } },
        { name: "running", downstream_pipeline: { status: "running" } },
        { name: "not started", downstream_pipeline: null },
        { name: 7, downstream_pipeline: { status: "failed" } },
      ],
    ]);
    const detail = await Effect.runPromise(provider.getDetail(ref, { checks: true }));
    expect(detail.headRepositoryNameWithOwner).toBe("fork/repo");
    expect(detail.checksComplete).toBe(true);
    expect(detail.checks?.[0]?.description).toBe("merge_request_event");
    expect(detail.checks?.map(({ name, status }) => [name, status])).toEqual([
      ["Pipeline", "success"],
      ["Downstream: deploy", "failure"],
      ["Downstream: optional", "neutral"],
      ["Downstream: running", "pending"],
    ]);
    expect(detail.checks?.[1]?.url).toBe("https://gitlab.com/fork/-/pipelines/32");
    expect(calls[1]?.url).toBe("https://gitlab.com/api/v4/projects/12");
    expect(calls[2]?.url).toBe(
      "https://gitlab.com/api/v4/projects/12/pipelines/31/bridges?per_page=100",
    );
  });

  it.each([
    new Response(null, { status: 403 }),
    new Response(null, { status: 429, headers: { "retry-after": "60" } }),
    Array.from({ length: 100 }, () => ({
      name: "child",
      downstream_pipeline: { status: "failed" },
    })),
    { invalid: "page" },
  ])("preserves the head check when trigger jobs cannot be read completely", async (response) => {
    const { provider, ref } = fixture("gitlab", [
      { iid: 7, head_pipeline: { id: 31, project_id: 12, status: "success" } },
      response,
    ]);
    const detail = await Effect.runPromise(provider.getDetail(ref, { checks: true }));
    expect(detail.checks?.map((check) => check.status)).toEqual(["success"]);
    expect(detail.checksComplete).toBe(false);
  });

  it.each(["ready", "draft"] as const)(
    "does not read optional checks before %s writes",
    async (action) => {
      const { provider, ref, calls } = fixture("gitlab", [
        {
          iid: 7,
          title: "Draft: Change",
          head_pipeline: { id: 31, project_id: 12, status: "success" },
        },
        {},
      ]);
      await Effect.runPromise(provider.performAction({ ref, action }));
      expect(calls.map((call) => call.init.method)).toEqual(["GET", "PUT"]);
      expect(calls.some((call) => call.url.includes("/bridges"))).toBe(false);
    },
  );

  it("edits GitLab reviewers without an optional pipeline read", async () => {
    const { provider, calls } = fixture("gitlab", [
      {
        iid: 7,
        title: "Change",
        reviewers: [{ id: 4 }],
        head_pipeline: { id: 31, project_id: 12, status: "success" },
      },
      {},
    ]);
    await Effect.runPromise(
      provider.changePullRequestReviewers({
        cwd: "/repo",
        url: "https://gitlab.com/team/repo/-/merge_requests/7",
        add: ["5"],
        remove: ["4"],
      }),
    );
    expect(calls.map((call) => call.init.method)).toEqual(["GET", "PUT"]);
    expect(JSON.parse(String(calls[1]?.init.body))).toEqual({ reviewer_ids: [5] });
  });

  it.each([
    ["gitlab", { sha: "abc1234", diff_refs: null, merge_commit_sha: "wrong" }, "abc1234"],
    ["gitlab", { sha: "  " }, null],
    ["gitlab", { sha: null }, null],
    ["forgejo", { head: { sha: "head-commit" } }, "head-commit"],
    ["bitbucket", { source: { commit: { hash: "9f3a7c2d8b1e" } } }, "9f3a7c2d8b1e"],
    [
      "bitbucket",
      { source: { commit: { hash: "9f3a7c2d8b1e6f045a9c3d7e2b8f1a6c0d4e5f93" } } },
      "9f3a7c2d8b1e6f045a9c3d7e2b8f1a6c0d4e5f93",
    ],
    ["bitbucket", { source: { commit: null } }, null],
  ] as const)(
    "preserves %s native PR head commits without inventing absent heads",
    async (kind, metadata, head) => {
      const { provider, ref } = fixture(kind, [
        { id: 7, iid: 7, number: 7, title: "Change", ...metadata },
      ]);
      expect((await Effect.runPromise(provider.getDetail(ref))).headRefOid).toBe(head);
    },
  );
  it("posts GitLab context discussions with both native coordinates and rename paths", async () => {
    const { provider, ref, calls } = fixture("gitlab");
    await Effect.runPromise(
      provider.writeComment({
        ref,
        body: "Context",
        path: "new.ts",
        oldPath: "old.ts",
        side: "new",
        position: { kind: "context", oldLine: 5, newLine: 8 },
        headSha: "head",
        baseSha: "base",
        startSha: "start",
      }),
    );
    expect(JSON.parse(String(calls[0]?.init.body)).position).toEqual({
      position_type: "text",
      old_path: "old.ts",
      new_path: "new.ts",
      old_line: 5,
      new_line: 8,
      head_sha: "head",
      base_sha: "base",
      start_sha: "start",
    });
  });
  it("posts Forgejo reviews with native side coordinates, rename paths and pinned commit", async () => {
    const { provider, ref, calls } = fixture("forgejo");
    for (const [side, position] of [
      ["old", { kind: "deleted", oldLine: 5 }],
      ["new", { kind: "added", newLine: 8 }],
      ["old", { kind: "context", oldLine: 5, newLine: 8 }],
      ["new", { kind: "context", oldLine: 5, newLine: 8 }],
    ] as const) {
      await Effect.runPromise(
        provider.writeComment({
          ref,
          body: "Inline",
          path: "new.ts",
          oldPath: "old.ts",
          side,
          position,
          headSha: "head",
        }),
      );
    }
    expect(calls.map((call) => JSON.parse(String(call.init.body)))).toEqual([
      {
        body: "Inline",
        event: "COMMENT",
        commit_id: "head",
        comments: [{ path: "old.ts", body: "Inline", old_position: 5, new_position: 0 }],
      },
      {
        body: "Inline",
        event: "COMMENT",
        commit_id: "head",
        comments: [{ path: "new.ts", body: "Inline", old_position: 0, new_position: 8 }],
      },
      {
        body: "Inline",
        event: "COMMENT",
        commit_id: "head",
        comments: [{ path: "old.ts", body: "Inline", old_position: 5, new_position: 0 }],
      },
      {
        body: "Inline",
        event: "COMMENT",
        commit_id: "head",
        comments: [{ path: "new.ts", body: "Inline", old_position: 0, new_position: 8 }],
      },
    ]);
  });
  it("refuses native inline writes without validated coordinates before sending HTTP", async () => {
    for (const kind of ["gitlab", "forgejo"] as const) {
      const { provider, ref, calls } = fixture(kind);
      const result = await Effect.runPromise(
        provider
          .writeComment({
            ref,
            body: "Inline",
            path: "a.ts",
            line: 4,
            side: "new",
            headSha: "head",
            baseSha: "base",
            startSha: "start",
          })
          .pipe(Effect.result),
      );
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") expect(result.failure.requestDispatched).toBe(false);
      expect(calls).toHaveLength(0);
    }
  });
  it("shares rate-limit cooldown across instances while isolating other accounts", async () => {
    const login = `limited-${++nextAccount}`;
    const first = fixture(
      "gitlab",
      [new Response("", { status: 429, headers: { "retry-after": "120" } })],
      login,
    );
    const second = fixture("gitlab", [], login);
    const other = fixture("gitlab");
    const firstResult = await Effect.runPromise(
      first.provider.getComments(first.ref).pipe(Effect.result),
    );
    expect(firstResult._tag).toBe("Failure");
    const blocked = await Effect.runPromise(
      second.provider.getComments(second.ref).pipe(Effect.result),
    );
    expect(blocked._tag).toBe("Failure");
    if (blocked._tag === "Failure")
      expect(blocked.failure).toMatchObject({ kind: "rate_limited", requestDispatched: false });
    expect(second.calls).toHaveLength(0);
    await Effect.runPromise(other.provider.getDetail(other.ref));
    expect(other.calls).toHaveLength(1);
  });
  it("pauses subsequent requests after a successful exhausted-budget response", async () => {
    const { provider, ref, calls } = fixture("gitlab", [
      Response.json(
        {},
        {
          headers: {
            "ratelimit-remaining": "0",
            "ratelimit-reset": String(Math.ceil(Date.now() / 1000) + 120),
          },
        },
      ),
    ]);
    await Effect.runPromise(provider.getDetail(ref));
    const blocked = await Effect.runPromise(provider.getDetail(ref).pipe(Effect.result));
    expect(blocked._tag).toBe("Failure");
    expect(calls).toHaveLength(1);
  });
  it("maps GitLab reaction contents to native award names", async () => {
    const { provider, ref, calls } = fixture("gitlab");
    for (const content of ["+1", "-1", "laugh", "hooray", "heart"]) {
      await Effect.runPromise(provider.react({ ref, commentId: "9", content }));
    }
    expect(calls.map((call) => JSON.parse(String(call.init.body)).name)).toEqual([
      "thumbsup",
      "thumbsdown",
      "laughing",
      "tada",
      "heart",
    ]);
  });
  for (const kind of ["gitlab", "bitbucket", "azure-devops", "forgejo"] as const) {
    it(`${kind} exposes its exact capability exclusions`, () => {
      const { provider } = fixture(kind);
      expect(provider.forgeCapabilities).toEqual(FORGE_CAPABILITIES[kind]);
      expect(provider.forgeCapabilities.stacks).toBe(false);
      expect(provider.forgeCapabilities.diff).toBe(true);
      expect(provider.forgeCapabilities.viewedFiles).toBe("f5");
    });
    it(`${kind} performs a typed merge against the scoped account`, async () => {
      const { provider, ref, calls } = fixture(kind);
      if (kind === "bitbucket") {
        expect(
          (
            await Effect.runPromiseExit(
              provider.performAction({
                ref,
                action: "merge",
                method: "squash",
                expectedHeadOid: "head-sha",
              }),
            )
          )._tag,
        ).toBe("Failure");
        expect(calls).toHaveLength(0);
        return;
      }
      await Effect.runPromise(
        provider.performAction({
          ref,
          action: "merge",
          method: "squash",
          expectedHeadOid: "head-sha",
        }),
      );
      expect(calls).toHaveLength(1);
      expect(calls[0]?.init.redirect).toBe("error");
      const body = JSON.parse(String(calls[0]?.init.body));
      if (kind === "gitlab") expect(body).toMatchObject({ sha: "head-sha", squash: true });
      if (kind === "forgejo")
        expect(body).toMatchObject({ Do: "squash", head_commit_id: "head-sha" });
      if (kind === "azure-devops")
        expect(body).toMatchObject({
          status: "completed",
          completionOptions: { mergeStrategy: "squash" },
          lastMergeSourceCommit: { commitId: "head-sha" },
        });
      expect(String(calls[0]?.url)).not.toContain("isolated-token");
    });
    it(`${kind} rejects GraphQL and wrong-host references before dispatch`, async () => {
      const { provider, ref, calls } = fixture(kind);
      const graph = await Effect.runPromiseExit(
        provider.query({ cwd: "/repo", document: "mutation { anything }" }),
      );
      const mismatch = await Effect.runPromiseExit(
        provider.getDetail({ ...ref, host: "attacker.example" }),
      );
      expect(graph._tag).toBe("Failure");
      expect(mismatch._tag).toBe("Failure");
      expect(calls).toHaveLength(0);
    });
  }
  it("GitLab rejects request changes and supports positioned discussions", async () => {
    const { provider, ref, calls } = fixture("gitlab");
    expect(
      (
        await Effect.runPromiseExit(
          provider.submitReview({ ref, body: "no", verdict: "request-changes" }),
        )
      )._tag,
    ).toBe("Failure");
    await Effect.runPromise(
      provider.writeComment({
        ref,
        body: "line comment",
        path: "src/a.ts",
        line: 4,
        position: { kind: "added", newLine: 4 },
        side: "new",
        baseSha: "base",
        startSha: "start",
        headSha: "head",
      }),
    );
    expect(calls[0]?.url).toContain("/merge_requests/7/discussions");
    expect(JSON.parse(String(calls[0]?.init.body)).position).toMatchObject({
      new_line: 4,
      base_sha: "base",
      start_sha: "start",
      head_sha: "head",
    });
  });
  it("Bitbucket writes replies and requests changes without unsupported reactions", async () => {
    const { provider, ref, calls } = fixture("bitbucket");
    await Effect.runPromise(provider.writeComment({ ref, body: "reply", replyTo: "123" }));
    await Effect.runPromise(provider.submitReview({ ref, body: "", verdict: "request-changes" }));
    expect(JSON.parse(String(calls[0]?.init.body))).toMatchObject({
      parent: { id: 123 },
      content: { raw: "reply" },
    });
    expect(calls[1]?.url).toContain("/request-changes");
    expect((await Effect.runPromiseExit(provider.react({ ref, content: "heart" })))._tag).toBe(
      "Failure",
    );
  });
  it("Azure reads its latest iteration and synthesizes a revision-specific patch", async () => {
    const { provider, ref, calls } = fixture("azure-devops", [
      {
        value: [
          { id: 1 },
          {
            id: 3,
            sourceRefCommit: { commitId: "new-sha" },
            targetRefCommit: { commitId: "old-sha" },
          },
        ],
      },
      { changeEntries: [{ changeType: "edit", item: { path: "/a.txt" } }] },
      { content: "old\n" },
      { content: "new\n" },
    ]);
    const files = await Effect.runPromise(provider.getFiles(ref));
    expect(calls[1]?.url).toContain("/iterations/3/changes");
    expect(files[0]).toMatchObject({ path: "/a.txt", revision: "new-sha" });
    expect(files[0]?.patch).toContain("-old\n+new");
    expect(
      (await Effect.runPromiseExit(provider.writeComment({ ref, body: "disabled" })))._tag,
    ).toBe("Failure");
  });

  it.each([true, false])("Azure preserves rename metadata (unchanged: %s)", async (unchanged) => {
    const { provider, ref } = fixture("azure-devops", [
      {
        value: [
          { id: 1, sourceRefCommit: { commitId: "new" }, targetRefCommit: { commitId: "old" } },
        ],
      },
      {
        changeEntries: [
          { changeType: "rename", originalPath: "/old.txt", item: { path: "/new.txt" } },
        ],
      },
      { content: "old\n" },
      { content: unchanged ? "old\n" : "new\n" },
    ]);
    const files = await Effect.runPromise(provider.getFiles(ref));
    expect(files[0]?.patch).toContain(
      "similarity index " +
        (unchanged ? "100" : "0") +
        "%\nrename from old.txt\nrename to new.txt\n",
    );
    expect(files[0]?.patch).toContain("diff --git a/old.txt b/new.txt\n");
    if (!unchanged) expect(files[0]?.patch).toContain("-old\n+new");
  });
  it("Forgejo replaces reviewers without silently keeping removed reviewers", async () => {
    const { provider, ref, calls } = fixture("forgejo", [
      { number: 7, requested_reviewers: [{ login: "old" }] },
      {},
      {},
    ]);
    await Effect.runPromise(provider.setReviewers({ ref, reviewers: ["new"] }));
    expect(calls.slice(1).map((call) => call.init.method)).toEqual(["DELETE", "POST"]);
    expect(JSON.parse(String(calls[1]?.init.body))).toEqual({ reviewers: ["old"] });
    expect(JSON.parse(String(calls[2]?.init.body))).toEqual({ reviewers: ["new"] });
    expect(
      (await Effect.runPromiseExit(provider.resolveThread({ ref, threadId: "x", resolved: true })))
        ._tag,
    ).toBe("Failure");
  });
  it("keeps ambiguous writes dispatched, sanitizes errors and scopes authentication", async () => {
    const { provider, ref, calls } = fixture("gitlab", [
      new Response("secret detail", { status: 429 }),
    ]);
    const result = await Effect.runPromise(
      provider
        .writeComment({ ref, body: "write" })
        .pipe(Effect.match({ onSuccess: () => null, onFailure: (error) => error })),
    );
    expect(result).toMatchObject({ kind: "rate_limited", requestDispatched: true });
    expect(result?.message).not.toContain("secret detail");
    expect(calls[0]?.init.headers).toMatchObject({ "PRIVATE-TOKEN": "isolated-token" });
  });
});

it.each(["gitlab", "bitbucket", "azure-devops", "forgejo"] as const)(
  "%s implements every advertised native state action",
  async (kind) => {
    const { provider, ref, calls } = fixture(kind);
    for (const action of FORGE_CAPABILITIES[kind].actions) {
      const before = calls.length;
      await Effect.runPromise(
        provider.performAction({
          ref,
          action,
          method: action === "update-branch" && kind === "gitlab" ? "rebase" : "merge",
        }),
      );
      expect(calls.length).toBeGreaterThan(before);
      expect(calls.at(-1)?.init.method).not.toBe("GET");
      const url = calls.at(-1)!.url;
      if (action === "update-branch")
        expect(url).toContain(kind === "gitlab" ? "/rebase" : "/update");
      if (action === "disable-auto-merge" && kind === "gitlab")
        expect(url).toContain("/cancel_merge_when_pipeline_succeeds");
      if (action === "close" && kind === "bitbucket") expect(url).toContain("/decline");
    }
  },
);
it.each(["gitlab", "bitbucket", "azure-devops", "forgejo"] as const)(
  "%s implements advertised edit and reviewer writes",
  async (kind) => {
    const { provider, ref, calls } = fixture(kind);
    await Effect.runPromise(
      provider.editChangeRequest({ ref, title: "Edited", body: "Updated description" }),
    );
    const payload = JSON.parse(String(calls[0]?.init.body));
    expect(payload).toMatchObject({
      title: "Edited",
      [kind === "forgejo" ? "body" : "description"]: "Updated description",
    });
    await Effect.runPromise(
      provider.setReviewers({ ref, reviewers: [kind === "gitlab" ? "123" : "reader"] }),
    );
    expect(calls.at(-1)?.init.method).toBe(kind === "forgejo" ? "POST" : "PUT");
    if (kind !== "azure-devops") {
      await Effect.runPromise(provider.editComment({ ref, commentId: "4", body: "Edited remark" }));
      expect(calls.at(-1)?.url).toContain(kind === "gitlab" ? "/notes/4" : "/comments/4");
    } else
      expect(
        (
          await Effect.runPromiseExit(
            provider.editComment({ ref, commentId: "4", body: "disabled" }),
          )
        )._tag,
      ).toBe("Failure");
  },
);
it("Forgejo writes labels and reactions but excludes draft conversion", async () => {
  const { provider, ref, calls } = fixture("forgejo");
  await Effect.runPromise(provider.setLabels({ ref, labels: ["12", "24"] }));
  expect(calls[0]?.url).toContain("/issues/7/labels");
  expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ labels: [12, 24] });
  await Effect.runPromise(provider.react({ ref, commentId: "9", content: "+1" }));
  expect(calls[1]?.url).toContain("/issues/comments/9/reactions");
  expect((await Effect.runPromiseExit(provider.performAction({ ref, action: "draft" })))._tag).toBe(
    "Failure",
  );
});
it("Bitbucket files receive the native diff rather than empty code views", async () => {
  const diff =
    "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n";
  const { provider, ref } = fixture("bitbucket", [
    { values: [{ new: { path: "src/a.ts" }, old: { path: "src/a.ts" }, status: "modified" }] },
    diff,
  ]);
  const files = await Effect.runPromise(provider.getFiles(ref));
  expect(files[0]?.patch).toBe(diff);
});
it("GitLab honors the project's native rebase merge policy", async () => {
  const unsupported = fixture("gitlab", [{ merge_method: "merge" }]);
  expect(
    (
      await Effect.runPromiseExit(
        unsupported.provider.performAction({
          ref: unsupported.ref,
          action: "merge",
          method: "rebase",
        }),
      )
    )._tag,
  ).toBe("Failure");
  expect(unsupported.calls).toHaveLength(1);
  const supported = fixture("gitlab", [{ merge_method: "ff" }, {}]);
  await Effect.runPromise(
    supported.provider.performAction({
      ref: supported.ref,
      action: "merge",
      method: "rebase",
      expectedHeadOid: "sha",
    }),
  );
  expect(supported.calls[1]?.url).toContain("/merge_requests/7/merge");
});

it("Azure does not invent text patches for binary files", async () => {
  const { provider, ref } = fixture("azure-devops", [
    {
      value: [
        { id: 2, sourceRefCommit: { commitId: "head" }, targetRefCommit: { commitId: "base" } },
      ],
    },
    { changeEntries: [{ changeType: "edit", item: { path: "/binary.png" } }] },
    { contentMetadata: { isBinary: true } },
    { contentMetadata: { isBinary: true } },
  ]);
  expect((await Effect.runPromise(provider.getFiles(ref)))[0]?.patch).toBeNull();
});
it("GitLab and Bitbucket verdicts reject bodies that require durable separate comment writes", async () => {
  for (const kind of ["gitlab", "bitbucket"] as const) {
    const { provider, ref, calls } = fixture(kind);
    expect(
      (
        await Effect.runPromiseExit(
          provider.submitReview({ ref, verdict: "approve", body: "must survive" }),
        )
      )._tag,
    ).toBe("Failure");
    expect(calls).toHaveLength(0);
  }
});
it("Azure removes reviewers excluded from the replacement set", async () => {
  const { provider, ref, calls } = fixture("azure-devops", [
    { pullRequestId: 7, reviewers: [{ id: "old" }] },
    {},
    {},
  ]);
  await Effect.runPromise(provider.setReviewers({ ref, reviewers: ["new"] }));
  expect(calls[1]?.url).toContain("/reviewers/new");
  expect(calls[1]?.init.method).toBe("PUT");
  expect(JSON.parse(String(calls[1]?.init.body))).toEqual({ id: "new", vote: 0 });
  expect(calls[2]?.url).toContain("/reviewers/old");
  expect(calls[2]?.init.method).toBe("DELETE");
});

it("matches quoted native UTF8 filenames and ignores header-like hunk contents", async () => {
  const diff =
    'diff --git "a/caf\\303\\251.ts" "b/caf\\303\\251.ts"\n--- "a/caf\\303\\251.ts"\n+++ "b/caf\\303\\251.ts"\n@@ -1 +1 @@\n--- a/other.ts\n+new\n';
  const { provider, ref } = fixture("bitbucket", [
    { values: [{ new: { path: "café.ts" }, old: { path: "café.ts" }, status: "modified" }] },
    diff,
  ]);
  expect((await Effect.runPromise(provider.getFiles(ref)))[0]?.patch).toBe(diff);
});
it("rejects a Bitbucket repository that is not workspace/repository before any request", async () => {
  for (const repository of ["repo", "team/repo/extra"]) {
    const { provider, calls } = fixture("bitbucket");
    const failure = await Effect.runPromise(
      Effect.flip(provider.getRepositoryCloneUrls({ cwd: "/w", repository })),
    );
    expect(failure.message).toContain("workspace/repository");
    expect(calls).toEqual([]);
  }
  const { provider, calls } = fixture("bitbucket", [
    { links: { clone: [{ name: "https", href: "https://bitbucket.org/team/other.git" }] } },
  ]);
  await Effect.runPromise(provider.getRepositoryCloneUrls({ cwd: "/w", repository: "team/other" }));
  expect(calls[0]?.url).toContain("api.bitbucket.org/2.0/repositories/team/other");
});
it("continues native Bitbucket metadata pagination without following arbitrary next URLs", async () => {
  const { provider, ref, calls } = fixture("bitbucket", [
    {
      values: [{ new: { path: "a.ts" }, status: "modified" }],
      next: "https://untrusted.example/next",
    },
    { values: [{ new: { path: "b.ts" }, status: "modified" }] },
    "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-a\n+b\n",
  ]);
  const files = await Effect.runPromise(provider.getFiles(ref));
  expect(files.map((file) => file.path)).toEqual(["a.ts", "b.ts"]);
  expect(calls[1]?.url).toContain(
    "api.bitbucket.org/2.0/repositories/team/repo/pullrequests/7/diffstat?pagelen=100&page=2",
  );
  expect(calls.every((call) => !call.url.includes("untrusted"))).toBe(true);
});

it("pages GitLab merge request diffs 30 files at a time so GitLab 15.7 to 17.10 answer", async () => {
  const page = (offset: number, count: number) =>
    Array.from({ length: count }, (_, index) => ({
      new_path: `file-${offset + index}.ts`,
      old_path: `file-${offset + index}.ts`,
      diff: "@@ -1 +1 @@\n-a\n+b\n",
    }));
  const { provider, ref, calls } = fixture("gitlab", [page(0, 30), page(30, 5)]);
  const files = await Effect.runPromise(provider.getFiles(ref));
  expect(files).toHaveLength(35);
  expect(calls.map((call) => new URL(call.url).search)).toEqual([
    "?per_page=30&page=1",
    "?per_page=30&page=2",
  ]);
});

it.each(["gitlab", "bitbucket", "azure-devops", "forgejo"] as const)(
  "lists terminal %s branch PRs when all states are requested",
  async (kind) => {
    const row =
      kind === "gitlab"
        ? {
            iid: 7,
            title: "Change",
            source_branch: "topic",
            target_branch: "main",
            state: "merged",
            sha: "head",
            updated_at: "2026-10-02T00:00:00Z",
          }
        : kind === "bitbucket"
          ? {
              id: 7,
              title: "Change",
              state: "MERGED",
              source: { branch: { name: "topic" }, commit: { hash: "head" } },
              destination: { branch: { name: "main" } },
              updated_on: "2026-10-02T00:00:00Z",
            }
          : kind === "azure-devops"
            ? {
                pullRequestId: 7,
                title: "Change",
                status: "completed",
                sourceRefName: "refs/heads/topic",
                targetRefName: "refs/heads/main",
                lastMergeSourceCommit: { commitId: "head" },
                closedDate: "2026-10-02T00:00:00Z",
              }
            : {
                number: 7,
                title: "Change",
                state: "closed",
                merged: true,
                head: { ref: "topic", sha: "head" },
                base: { ref: "main" },
                updated_at: "2026-10-02T00:00:00Z",
              };
    const payload =
      kind === "bitbucket" ? { values: [row] } : kind === "azure-devops" ? { value: [row] } : [row];
    const f = fixture(kind, [payload]);
    const result = await Effect.runPromise(
      f.provider.listOpenPullRequests({
        cwd: "/repo",
        headSelector: "topic",
        state: "all",
        limit: 100,
      }),
    );
    expect(result).toMatchObject([
      {
        number: 7,
        state: "merged",
        headRefOid: "head",
        headRefName: "topic",
        updatedAt: "2026-10-02T00:00:00Z",
      },
    ]);
    const url = new URL(f.calls[0]!.url);
    expect(url.searchParams.get(kind === "azure-devops" ? "searchCriteria.status" : "state")).toBe(
      kind === "bitbucket" ? "OPEN" : "all",
    );
    if (kind === "bitbucket") {
      expect(url.searchParams.getAll("state")).toEqual([
        "OPEN",
        "MERGED",
        "DECLINED",
        "SUPERSEDED",
      ]);
      expect(url.searchParams.get("pagelen")).toBe("50");
    }
  },
);
it("refuses a partial Bitbucket all-state page instead of treating its terminal rows as complete proof", async () => {
  const f = fixture("bitbucket", [{ values: [], next: "https://api.bitbucket.org/page/2" }]);
  expect(
    (
      await Effect.runPromise(
        f.provider
          .listOpenPullRequests({ cwd: "/repo", headSelector: "topic", state: "all" })
          .pipe(Effect.result),
      )
    )._tag,
  ).toBe("Failure");
});
it("checks the raw page bound before filtering unrelated branches", async () => {
  const f = fixture("forgejo", [
    [
      { number: 7, state: "closed", merged: true, head: { ref: "topic", sha: "head" } },
      { number: 8, state: "open", head: { ref: "another", sha: "other" } },
    ],
  ]);
  const result = await Effect.runPromise(
    f.provider
      .listOpenPullRequests({ cwd: "/repo", headSelector: "topic", state: "all", limit: 2 })
      .pipe(Effect.result),
  );
  expect(result._tag).toBe("Failure");
});
