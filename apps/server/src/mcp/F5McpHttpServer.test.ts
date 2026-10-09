import { assert, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import { Effect } from "effect";
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
        assert.equal(list.body.result?.tools.length, 15);
        assert.ok(list.body.result?.tools.every((tool) => tool.name.startsWith("computer_")));
        computerSession.dispose();
        previewSession.dispose();
        assert.equal((yield* post("computer", computerToken)).status, 401);
      }),
    ),
);
