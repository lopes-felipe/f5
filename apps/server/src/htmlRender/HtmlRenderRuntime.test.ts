import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ThreadId } from "@t3tools/contracts";
import { Effect, Layer } from "effect";
import { afterEach, expect, it } from "vitest";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { htmlRenderImageRoots, makeHtmlRenderRuntime } from "./HtmlRenderRuntime.ts";
import { prepareHtmlRender } from "./prepareHtmlRender.ts";

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it("lets a scratch thread inline only its own folder, not a sibling scratch thread's", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "f5-html-scratch-"));
  temporary.push(root);
  const own = path.join(root, "own");
  const sibling = path.join(root, "sibling");
  const attachments = path.join(root, "attachments");
  for (const folder of [own, sibling, attachments]) await mkdir(folder);
  await writeFile(path.join(own, "mine.png"), Buffer.from([1, 2, 3]));
  await writeFile(path.join(sibling, "theirs.png"), Buffer.from([4, 5, 6]));
  const roots = htmlRenderImageRoots(
    { worktreePath: null, scratchPath: own },
    { kind: "scratch", workspaceRoot: root },
    attachments,
  );
  expect(roots).toEqual([own, attachments]);
  await expect(prepareHtmlRender(`<img src="${own}/mine.png">`, roots)).resolves.toContain(
    "data:image/png;base64,AQID",
  );
  await expect(prepareHtmlRender(`<img src="${sibling}/theirs.png">`, roots)).rejects.toThrow();
  // A scratch thread whose folder is not allocated yet reads only attachments.
  expect(
    htmlRenderImageRoots(
      { worktreePath: null, scratchPath: null },
      { kind: "scratch", workspaceRoot: root },
      attachments,
    ),
  ).toEqual([attachments]);
});

it("keeps the project root and worktree for standard projects", () => {
  expect(
    htmlRenderImageRoots(
      { worktreePath: "/repo/.worktrees/a" },
      { kind: "standard", workspaceRoot: "/repo" },
      "/attachments",
    ),
  ).toEqual(["/repo", "/repo/.worktrees/a", "/attachments"]);
});

it("tells the agent why a page with a viewport height unit was refused", async () => {
  const threadId = ThreadId.makeUnsafe("html-thread");
  const engine = {
    getReadModel: () =>
      Effect.succeed({
        threads: [{ id: threadId, projectId: "project", deletedAt: null, worktreePath: null }],
        projects: [{ id: "project", kind: "standard", workspaceRoot: "/repo", deletedAt: null }],
      }),
    dispatch: () => Effect.die("A refused page must not be published."),
  } as unknown as Parameters<typeof makeHtmlRenderRuntime>[0]["engine"];
  const errors = await Effect.gen(function* () {
    const runtime = yield* makeHtmlRenderRuntime({
      engine,
      attachmentsDir: "/attachments",
      preview: {} as Parameters<typeof makeHtmlRenderRuntime>[0]["preview"],
    });
    const html = "<style>main{min-height:100vh}</style><main></main>";
    return [
      yield* Effect.flip(runtime.publish(threadId, { html, title: "Chart", height: 400 })),
      yield* Effect.flip(runtime.preview(threadId, { html })),
    ];
  }).pipe(
    Effect.provide(SqlitePersistenceMemory.pipe(Layer.provideMerge(NodeServices.layer))),
    Effect.runPromise,
  );
  for (const error of errors) expect(error.message).toContain("viewport height unit (100vh)");
});
