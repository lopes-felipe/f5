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
    const value = responses.shift() ?? {};
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
