import * as NodeFs from "node:fs/promises";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";

import { ProjectId, ThreadId } from "@t3tools/contracts";
import { Effect, Layer } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { GitHubCli, type GitHubCliShape } from "../git/Services/GitHubCli.ts";
import {
  INSPECTION_MCP_TOOLS,
  InspectionMcpHttpServer,
  InspectionMcpHttpServerLive,
} from "./InspectionMcpHttpServer.ts";

let base: string;
let projectA: string;
let projectB: string;

beforeEach(async () => {
  base = await NodeFs.realpath(
    await NodeFs.mkdtemp(NodePath.join(NodeOs.tmpdir(), "f5-inspection-mcp-")),
  );
  projectA = NodePath.join(base, "a");
  projectB = NodePath.join(base, "b");
  await NodeFs.mkdir(projectA);
  await NodeFs.mkdir(projectB);
  await NodeFs.writeFile(NodePath.join(projectA, "a.txt"), "alpha\n");
  await NodeFs.writeFile(NodePath.join(projectB, "b.txt"), "bravo\n");
});

afterEach(async () => {
  await NodeFs.rm(base, { recursive: true, force: true });
});

const layer = InspectionMcpHttpServerLive.pipe(
  Layer.provide(Layer.succeed(GitHubCli, {} as unknown as GitHubCliShape)),
);

async function call(
  url: string,
  token: string,
  method: string,
  params: Record<string, unknown> = {},
) {
  const response = await fetch(url, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  return {
    status: response.status,
    body: (await response.json()) as {
      result?: { isError?: boolean; tools?: Array<{ name: string; annotations?: unknown }> };
    },
  };
}

describe("inspection MCP facade", () => {
  it("scopes credentials to one thread's workspace and revokes them", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const server = yield* InspectionMcpHttpServer;
        const threadA = ThreadId.makeUnsafe("thread-a");
        const sessionA = yield* server.createSession({
          threadId: threadA,
          projectId: ProjectId.makeUnsafe("project-a"),
          profile: "unattended-readonly",
          roots: [projectA],
        });
        const sessionB = yield* server.createSession({
          threadId: ThreadId.makeUnsafe("thread-b"),
          projectId: ProjectId.makeUnsafe("project-b"),
          profile: "attended-readonly",
          roots: [projectB],
          existingServerNames: new Set(["f5_inspect"]),
        });
        expect(sessionA.serverName).toBe("f5_inspect");
        expect(sessionB.serverName).not.toBe("f5_inspect");

        const listed = yield* Effect.promise(() =>
          call(sessionA.url, sessionA.token, "tools/list"),
        );
        expect(listed.body.result?.tools?.map((tool) => tool.name)).toEqual(
          INSPECTION_MCP_TOOLS.map((tool) => tool.name),
        );
        for (const tool of listed.body.result?.tools ?? []) {
          expect(tool.annotations).toMatchObject({ readOnlyHint: true });
        }

        const own = yield* Effect.promise(() =>
          call(sessionA.url, sessionA.token, "tools/call", {
            name: "read_file",
            arguments: { path: "a.txt" },
          }),
        );
        expect(own.status).toBe(200);
        expect(own.body.result?.isError).not.toBe(true);

        // Another project's files are outside this credential's roots.
        const crossProject = yield* Effect.promise(() =>
          call(sessionA.url, sessionA.token, "tools/call", {
            name: "read_file",
            arguments: { path: NodePath.join(projectB, "b.txt") },
          }),
        );
        expect(crossProject.body.result?.isError).toBe(true);

        const unknown = yield* Effect.promise(() =>
          call(sessionA.url, "not-a-token", "tools/list"),
        );
        expect(unknown.status).toBe(401);

        // A new session for the same thread rotates its credential.
        const rotated = yield* server.createSession({
          threadId: threadA,
          projectId: ProjectId.makeUnsafe("project-a"),
          profile: "unattended-readonly",
          roots: [projectA],
        });
        const stale = yield* Effect.promise(() => call(sessionA.url, sessionA.token, "tools/list"));
        expect(stale.status).toBe(401);

        yield* server.revokeThread(threadA);
        const revoked = yield* Effect.promise(() => call(rotated.url, rotated.token, "tools/list"));
        expect(revoked.status).toBe(401);
        const stillValid = yield* Effect.promise(() =>
          call(sessionB.url, sessionB.token, "tools/list"),
        );
        expect(stillValid.status).toBe(200);
      }).pipe(Effect.provide(layer)),
    );
  });
});
