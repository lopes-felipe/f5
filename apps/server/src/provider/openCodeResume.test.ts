import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";
import { createOpencodeClient } from "@opencode-ai/sdk/v2";
import {
  getOpenCodeResumeSession,
  isOpenCodeNotFound,
  isSameOpenCodeDirectory,
  isOpenCodeHistoryContinuation,
} from "./openCodeResume.ts";

it("recognizes only structured missing-session errors through runtime wrappers", () => {
  for (const cause of [
    { cause: new Error("missing", { cause: { status: 404 } }) },
    { cause: { response: { status: 404 } } },
    { statusCode: 404 },
    { body: { name: "NotFoundError" } },
  ])
    assert.equal(isOpenCodeNotFound(cause), true);
  for (const cause of [
    undefined,
    new Error("session not found"),
    { name: "ProviderNotFoundError" },
    { status: 500, body: { name: "NotFoundError" } },
    { cause: { response: { status: 401 }, body: { name: "NotFoundError" } } },
  ])
    assert.equal(isOpenCodeNotFound(cause), false);
  const cyclic: { cause?: unknown } = {};
  cyclic.cause = cyclic;
  assert.equal(isOpenCodeNotFound(cyclic), false);
});

it("preserves HTTP status through real SDK resume errors", async () => {
  for (const [status, body] of [
    [404, { name: "NotFoundError", data: { message: "Session missing" } }],
    [500, { name: "UnknownError", data: { message: "Temporary failure" } }],
    [500, { name: "NotFoundError", data: { message: "Wrapped provider failure" } }],
    [401, "Unauthorized"],
  ] as const) {
    const client = createOpencodeClient({
      baseUrl: "http://opencode.test",
      throwOnError: true,
      fetch: Object.assign(
        async () =>
          typeof body === "string"
            ? new Response(body, { status })
            : Response.json(body, { status }),
        { preconnect: fetch.preconnect },
      ),
    });
    const result = await Effect.runPromise(
      getOpenCodeResumeSession(client, "ses_saved").pipe(Effect.result),
    );
    assert.equal(result._tag, "Failure");
    if (result._tag === "Failure") assert.equal(isOpenCodeNotFound(result.failure), status === 404);
  }
});

it("recognizes preserved fork history without accepting an empty replacement", () => {
  const cursor = { schemaVersion: 1, sessionId: "ses_saved" };
  assert.equal(
    isOpenCodeHistoryContinuation(cursor, {
      schemaVersion: 1,
      sessionId: "ses_fork",
      forkedFromSessionId: "ses_saved",
    }),
    true,
  );
  assert.equal(
    isOpenCodeHistoryContinuation(cursor, { schemaVersion: 1, sessionId: "ses_new" }),
    false,
  );
  assert.equal(
    isOpenCodeHistoryContinuation(cursor, {
      schemaVersion: 99,
      sessionId: "ses_fork",
      forkedFromSessionId: "ses_saved",
    }),
    false,
  );
});

it.layer(NodeServices.layer)("OpenCode resume directories", (it) => {
  it.effect("reuses symlinked paths and handles unavailable directories", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const temp = yield* fs.makeTempDirectoryScoped();
      const original = path.join(temp, "original");
      const link = path.join(temp, "link");
      yield* fs.makeDirectory(original);
      yield* fs.symlink(original, link);
      assert.equal(yield* isSameOpenCodeDirectory(fs, path, original, link), true);
      assert.equal(yield* isSameOpenCodeDirectory(fs, path, original + "/.", original), true);
      assert.equal(yield* isSameOpenCodeDirectory(fs, path, "/missing/a", "/missing/b"), false);
    }).pipe(Effect.scoped),
  );
});
