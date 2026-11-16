import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { HtmlPreviewResult, ThreadId } from "@t3tools/contracts";
import { Cause, Effect, Exit, Layer, Option, Schema } from "effect";
import { afterEach, expect, it } from "vitest";
import { ThreadToolError } from "../mcp/threadMcpTools.ts";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ensureAttachmentSchema } from "../persistence/Migrations/AttachmentSchema.ts";
import ownerKindsMigration from "../persistence/Migrations/095_AttachmentOwnerKinds.ts";
import activityOwnerMigration from "../persistence/Migrations/109_AttachmentOwnerActivity.ts";
import * as SqliteClient from "../persistence/NodeSqliteClient.ts";
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
  expect((await prepareHtmlRender(`<img src="${own}/mine.png">`, roots)).html).toContain(
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

const runtimeLayer = Layer.mergeAll(NodeServices.layer, SqliteClient.layerMemory());
const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

async function runtimeFixture(preview: HtmlPreviewResult = readyPreview(640)) {
  const root = await mkdtemp(path.join(os.tmpdir(), "f5-html-runtime-"));
  temporary.push(root);
  const project = path.join(root, "project");
  const attachments = path.join(root, "attachments");
  await mkdir(project);
  await mkdir(attachments);
  await writeFile(path.join(project, "chart.png"), Buffer.from(PNG, "base64"));
  const threadId = ThreadId.makeUnsafe("html-thread");
  const dispatched: unknown[] = [];
  const rendered: unknown[] = [];
  const model = {
    threads: [
      {
        id: threadId,
        projectId: "project",
        deletedAt: null,
        archivedAt: null,
        worktreePath: null,
        latestTurn: null,
      },
    ],
    projects: [{ id: "project", deletedAt: null, kind: "standard", workspaceRoot: project }],
  };
  const make = makeHtmlRenderRuntime({
    engine: {
      getReadModel: () => Effect.succeed(model as never),
      dispatch: (command) =>
        Effect.sync(() => {
          dispatched.push(command);
          return { sequence: 1 } as never;
        }),
    },
    attachmentsDir: attachments,
    preview: {
      render: (_threadId: ThreadId, input: unknown) =>
        Effect.sync(() => {
          rendered.push(input);
          return preview;
        }),
    } as never,
  });
  const run = <A, E>(use: (runtime: Effect.Success<typeof make>) => Effect.Effect<A, E>) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`CREATE TABLE projection_threads (thread_id TEXT PRIMARY KEY)`;
        yield* sql`INSERT INTO projection_threads VALUES (${threadId})`;
        yield* ensureAttachmentSchema;
        yield* ownerKindsMigration;
        yield* activityOwnerMigration;
        return yield* make.pipe(Effect.flatMap(use));
      }).pipe(Effect.provide(runtimeLayer)) as Effect.Effect<A>,
    );
  return { project, threadId, dispatched, rendered, run };
}
const readyPreview = (contentHeight: number): HtmlPreviewResult => ({
  _tag: "Ready",
  png: "cG5n",
  width: 880,
  contentHeight,
  capturedHeight: Math.min(2000, contentHeight),
  consoleMessages: [],
});

it("fails publishing with every missing image and dispatches nothing", async () => {
  const { project, threadId, dispatched, run } = await runtimeFixture();
  const html = Array.from({ length: 25 }, (_, index) => `<img src="${project}/gone-${index}.png">`)
    .concat(`<img src="${project}/chart.png">`)
    .join("");
  const exit = await run((runtime) =>
    Effect.exit(runtime.publish(threadId, { html, title: "Chart", height: 300 })),
  );
  expect(dispatched).toEqual([]);
  expect(Exit.isFailure(exit)).toBe(true);
  const error = Exit.isFailure(exit) ? Cause.findErrorOption(exit.cause) : Option.none();
  expect(Option.getOrUndefined(error)).toBeInstanceOf(ThreadToolError);
  const message = Option.isSome(error) ? (error.value as ThreadToolError).message : "";
  expect(message).toContain(`These local images could not be read: ${project}/gone-0.png, `);
  expect(message).toContain(", and 5 more. Use absolute paths to existing image files");
});

it("stores the clamped height and tells the agent not to restate the page", async () => {
  const { project, threadId, dispatched, run } = await runtimeFixture();
  const published = await run((runtime) =>
    Effect.all([
      runtime.publish(threadId, {
        html: `<img src="${project}/chart.png">`,
        title: "Chart",
        height: 300,
      }),
      runtime.publish(threadId, { html: "<p>Tall</p>", title: "Tall", height: 3500 }),
    ]),
  );
  expect(published.map((result) => result.htmlRender.height)).toEqual([300, 2000]);
  expect(published[0]!.message).toBe(
    "Shown to the reader above your reply. Don't mention or describe the page; reply with only what it doesn't already say.",
  );
  expect(dispatched).toHaveLength(2);
});

it("passes preview diagnostics through and notes pages past the inline limit", async () => {
  const tall = await runtimeFixture(readyPreview(25_000));
  const result = await tall.run((runtime) =>
    runtime.preview(tall.threadId, {
      html: `<img src="${tall.project}/gone.png"><img src="${tall.project}/chart.png">`,
    }),
  );
  expect(tall.rendered).toMatchObject([{ width: 880, appearance: "dark" }]);
  expect(result).toMatchObject({
    _tag: "Ready",
    missingImages: [`${tall.project}/gone.png`],
    note: "Inline frames show at most 20000px; the rest is only reachable full screen. Shorten the page.",
  });
  expect(result).not.toHaveProperty("missingImagesOmitted");
  expect(Schema.decodeUnknownSync(HtmlPreviewResult)(result)).toEqual(result);
  const short = await runtimeFixture(readyPreview(400));
  expect(
    await short.run((runtime) => runtime.preview(short.threadId, { html: "<p>Hi</p>" })),
  ).not.toHaveProperty("note");
});

it("decodes a maximal ready preview", () => {
  const maximal = {
    ...readyPreview(100_000),
    consoleMessages: Array.from({ length: 100 }, () => "x".repeat(1000)),
    missingImages: Array.from({ length: 20 }, () => "/".repeat(1024)),
    missingImagesOmitted: 10_000,
    note: "n".repeat(256),
  };
  expect(Schema.decodeUnknownSync(HtmlPreviewResult)(maximal)).toEqual(maximal);
});
