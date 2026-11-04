import { assert, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import { Effect } from "effect";
import { vi } from "vitest";
import { makePreviewAutomationBroker, PreviewAutomationBroker } from "./PreviewAutomationBroker";
import { makePreviewMcpHttpServer } from "./PreviewMcpHttpServer";
import {
  ComputerAutomationBroker,
  type ComputerAutomationBrokerRuntime,
} from "../computer/ComputerAutomationBroker";

it.effect(
  "scopes bearer tokens to their catalog and never serves execute or consent over another endpoint",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const computer = {
          bindSession: () => {},
          subscribe: () => () => {},
          releaseSession: () => {},
        };
        const preview = makePreviewAutomationBroker();
        const server = yield* makePreviewMcpHttpServer.pipe(
          Effect.provideService(PreviewAutomationBroker, preview),
          Effect.provideService(
            ComputerAutomationBroker,
            computer as unknown as ComputerAutomationBrokerRuntime,
          ),
        );
        yield* Effect.addFinalizer(() => preview.shutdown);
        const threadId = ThreadId.makeUnsafe("t");
        const previewSession = server.createSessionConfig({ threadId });
        const computerSession = server.createSessionConfig({ threadId, catalog: "computer" });
        const previewToken = Object.values(previewSession.env)[0]!;
        const computerToken = Object.values(computerSession.env)[0]!;
        const post = (catalog: "preview" | "computer", token: string) =>
          Effect.promise(async () => {
            const response = await fetch(server.getUrl(catalog), {
              method: "POST",
              headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
              body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
            });
            return {
              status: response.status,
              body: (await response.json()) as { result?: { tools: Array<{ name: string }> } },
            };
          });
        assert.equal((yield* post("computer", previewToken)).status, 401);
        assert.equal((yield* post("preview", computerToken)).status, 401);
        const list = yield* post("computer", computerToken);
        assert.equal(list.status, 200);
        assert.equal(list.body.result?.tools.length, 18);
        assert.ok(list.body.result?.tools.every((tool) => tool.name.startsWith("computer_")));
        computerSession.dispose();
        previewSession.dispose();
        assert.equal((yield* post("computer", computerToken)).status, 401);
      }),
    ),
);

it.effect(
  "scopes reused mutation RPC IDs to a new MCP initialization and rejects retired sessions",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const invoke = vi.fn(async () => ({ available: true }));
        const computer = {
          bindSession: () => {},
          subscribe: () => () => {},
          releaseSession: () => {},
          invoke,
          classify: async () => "foreground",
        };
        const preview = makePreviewAutomationBroker();
        const server = yield* makePreviewMcpHttpServer.pipe(
          Effect.provideService(PreviewAutomationBroker, preview),
          Effect.provideService(
            ComputerAutomationBroker,
            computer as unknown as ComputerAutomationBrokerRuntime,
          ),
        );
        yield* Effect.addFinalizer(() => preview.shutdown);
        const config = server.createSessionConfig({
          threadId: ThreadId.makeUnsafe("reload"),
          catalog: "computer",
        });
        const token = Object.values(config.env)[0]!;
        const post = (method: string, rpcSession?: string) =>
          Effect.promise(async () => {
            const response = await fetch(server.getUrl("computer"), {
              method: "POST",
              headers: {
                authorization: `Bearer ${token}`,
                "content-type": "application/json",
                ...(rpcSession ? { "Mcp-Session-Id": rpcSession } : {}),
              },
              body: JSON.stringify({
                jsonrpc: "2.0",
                id: 1,
                method,
                ...(method === "tools/call"
                  ? { params: { name: "computer_type", arguments: { text: "fixture" } } }
                  : {}),
              }),
            });
            return {
              status: response.status,
              session: response.headers.get("mcp-session-id"),
              body: await response.json(),
            };
          });
        const first = (yield* post("initialize")).session!;
        const result = yield* post("tools/call", first);
        assert.equal(JSON.stringify(result.body).includes("ReplayRejected"), false);
        assert.equal(invoke.mock.calls.length, 1);
        assert.equal(
          JSON.stringify((yield* post("tools/call", first)).body).includes("ReplayRejected"),
          true,
        );
        const second = (yield* post("initialize")).session!;
        assert.notEqual(second, first);
        assert.equal((yield* post("tools/call", first)).status, 404);
        assert.equal((yield* post("tools/call")).status, 404);
        assert.equal(
          JSON.stringify((yield* post("tools/call", second)).body).includes("ReplayRejected"),
          false,
        );
        assert.equal(invoke.mock.calls.length, 2);
        config.dispose();
      }),
    ),
);
