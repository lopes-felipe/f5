import { describe, expect, it } from "vitest";
import { forgeReviewThreads } from "./forgeModel.ts";
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
