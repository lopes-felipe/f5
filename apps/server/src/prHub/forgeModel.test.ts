import { describe, expect, it } from "vitest";
import { forgeReviewThreads, forgeTracked, forgeDetail } from "./forgeModel.ts";
import {
  gitLabHeadPipelineChecks,
  gitLabTriggerJobChecks,
} from "../sourceControl/gitLabPipelineChecks.ts";
import {
  FORGE_CAPABILITIES,
  type ForgeProvider,
} from "../sourceControl/ForgeSourceControlProvider.ts";
const provider = (resolve = true) =>
  ({
    forgeCapabilities: {
      ...FORGE_CAPABILITIES.gitlab,
      review: { ...FORGE_CAPABILITIES.gitlab.review, resolve },
    },
  }) as ForgeProvider;

it.each([undefined, false, true])(
  "distinguishes unread Forgejo checks from incomplete reads (%s)",
  (complete) => {
    const detail = {
      number: 7,
      title: "Checks",
      body: "",
      url: "",
      baseRefName: "main",
      headRefName: "topic",
      raw: {},
      ...(complete === undefined ? {} : { checks: [], checksComplete: complete }),
    };
    const pr = forgeTracked(
      {
        id: "forgejo-list",
        provider: "forgejo",
        host: "codeberg.org",
        login: "alice",
        viewerId: "1",
        generation: "1",
      },
      { provider: "forgejo", host: "codeberg.org", repository: "team/repo", number: 7 },
      detail,
      provider(),
    );
    expect(pr.checkRollup).toBe(complete === false ? "pending" : "none");
    expect(forgeDetail(pr, detail).detail.truncatedSections).toEqual(
      complete === false ? ["checks"] : undefined,
    );
  },
);

it.each([
  [true, true, "success"],
  [false, true, "failure"],
  [true, false, "pending"],
] as const)("rolls up Forgejo required=%s complete=%s as %s", (required, complete, expected) => {
  const detail = {
    number: 7,
    title: "Checks",
    body: "",
    url: "",
    baseRefName: "main",
    headRefName: "topic",
    raw: {},
    checksComplete: complete,
    checks: [
      { name: "ci", status: "success" as const, description: null, url: null, required },
      { name: "optional", status: "failure" as const, description: null, url: null },
    ],
  };
  const pr = forgeTracked(
    {
      id: "forgejo",
      provider: "forgejo",
      host: "codeberg.org",
      login: "alice",
      viewerId: "1",
      generation: "1",
    },
    { provider: "forgejo", host: "codeberg.org", repository: "team/repo", number: 7 },
    // Incomplete provider reads expose no checks.
    { ...detail, checks: complete ? detail.checks : [] },
    provider(),
  );
  expect(pr.checkRollup).toBe(expected);
  expect(
    forgeDetail(pr, { ...detail, checks: complete ? detail.checks : [] }).detail.truncatedSections,
  ).toEqual(complete ? undefined : ["checks"]);
});

it.each([
  ["canceled", false, "failure"],
  ["cancelling", false, "failure"],
  ["manual", false, "pending"],
  ["skipped", false, "pending"],
  ["success", true, "success"],
] as const)(
  "rolls up a %s head with allowed child failure=%s as %s",
  (status, allowed, expected) => {
    const raw = { head_pipeline: { status } };
    const detail = {
      number: 7,
      title: "Change",
      body: "",
      url: "",
      baseRefName: "main",
      headRefName: "topic",
      headRefOid: "head",
      raw,
      checksComplete: true,
      checks: [
        ...gitLabHeadPipelineChecks(raw.head_pipeline),
        ...(allowed
          ? (gitLabTriggerJobChecks([
              { name: "test", allow_failure: true, downstream_pipeline: { status: "failed" } },
            ]) ?? [])
          : []),
      ],
    };
    const pr = forgeTracked(
      {
        id: "a",
        provider: "gitlab",
        host: "gitlab.com",
        login: "alice",
        viewerId: "1",
        generation: "1",
      },
      { provider: "gitlab", host: "gitlab.com", repository: "team/repo", number: 7 },
      detail,
      provider(),
    );
    expect(pr.checkRollup).toBe(expected);
    expect(forgeDetail(pr, { ...detail, checksComplete: false }).detail.truncatedSections).toEqual([
      "checks",
    ]);
  },
);
describe("native per-item permissions", () => {
  it("retains host edit and resolution denials instead of repository defaults", () => {
    const [thread] = forgeReviewThreads(
      [
        {
          id: "thread",
          canResolve: false,
          notes: [
            {
              id: 1,
              position: { new_path: "a.ts", new_line: 1 },
              canEdit: false,
            },
          ],
        },
      ],
      provider(),
    );
    expect(thread).toMatchObject({
      canResolve: false,
      viewerCanResolve: false,
      viewerCanUnresolve: false,
    });
    expect(thread?.comments[0]?.canEdit).toBe(false);
  });
  it("an item grant cannot widen host capabilities and omission retains inheritance", () => {
    const raw = { id: "thread", comments: [{ id: 1, path: "a.ts" }] };
    expect(forgeReviewThreads([raw], provider())[0]).toMatchObject({ viewerCanResolve: true });
    const [thread] = forgeReviewThreads([{ ...raw, canResolve: true }], provider(false));
    expect(thread).toMatchObject({
      canResolve: true,
      viewerCanResolve: false,
      viewerCanUnresolve: false,
    });
    expect(thread?.comments[0]).not.toHaveProperty("canEdit");
  });
});

it("retains native directional reply/resolve restrictions when normalizing a discussion", () => {
  const [thread] = forgeReviewThreads(
    [
      {
        id: "thread",
        viewerCanReply: false,
        viewerCanResolve: false,
        viewerCanUnresolve: true,
        comments: [{ id: 1, path: "a.ts" }],
      },
    ],
    provider(),
  );
  expect(thread).toMatchObject({
    viewerCanReply: false,
    viewerCanResolve: false,
    viewerCanUnresolve: true,
  });
});
