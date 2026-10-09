import { ThreadId } from "@t3tools/contracts";
import { Effect } from "effect";
import { expect, it } from "vitest";
import { ComputerAutomationBroker } from "../src/computer/ComputerAutomationBroker";
import { makePreviewMcpHttpServer } from "../src/mcp/PreviewMcpHttpServer";
import {
  makePreviewAutomationBroker,
  PreviewAutomationBroker,
} from "../src/mcp/PreviewAutomationBroker";
import { computerHostFixture } from "./computer/hostFixture";

it("serves the complete computer catalog through consent, image, input, interruption and cleanup", async () => {
  const fixture = await computerHostFixture();
  const preview = makePreviewAutomationBroker();
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        yield* Effect.addFinalizer(() => Effect.sync(() => fixture.broker.close()));
        yield* Effect.addFinalizer(() => preview.shutdown);
        const server = yield* makePreviewMcpHttpServer.pipe(
          Effect.provideService(PreviewAutomationBroker, preview),
          Effect.provideService(ComputerAutomationBroker, fixture.broker),
        );
        const session = server.createSessionConfig({
          threadId: ThreadId.makeUnsafe("transport-thread"),
          catalog: "computer",
        });
        const token = Object.values(session.env)[0]!;
        let nextRpcId = 0;
        const rpc = async (method: string, params: unknown = {}, id = ++nextRpcId) => {
          const response = await fetch(server.getUrl("computer"), {
            method: "POST",
            headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
            body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
          });
          return { status: response.status, body: (await response.json()) as any };
        };
        yield* Effect.promise(async () => {
          expect((await rpc("tools/list")).body.result.tools).toHaveLength(15);
          expect(
            (await rpc("tools/call", { name: "computer_status", arguments: {} })).body.result
              .isError,
          ).toBeFalsy();
          const access = await rpc("tools/call", {
            name: "computer_request_access",
            arguments: { apps: ["F5 transport test app"], reason: "Protocol integration test" },
          });
          expect(access.body.result.isError).toBeFalsy();
          const image = await rpc("tools/call", { name: "computer_screenshot", arguments: {} });
          expect(image.body.result.content.some((block: any) => block.type === "image")).toBe(true);
          const clickId = ++nextRpcId;
          const click = await rpc(
            "tools/call",
            { name: "computer_click", arguments: { x: 0, y: 0 } },
            clickId,
          );
          const replay = await rpc(
            "tools/call",
            { name: "computer_click", arguments: { x: 0, y: 0 } },
            clickId,
          );
          expect(JSON.stringify(replay.body)).toContain("ReplayRejected");
          expect(fixture.seen.filter((request) => request.op === "click")).toHaveLength(1);
          expect(click.body.result.isError).toBeFalsy();
          expect(
            fixture.seen.find((request) => request.op === "click")?.authorization.grants,
          ).toHaveLength(1);
          expect(fixture.consentCount()).toBe(2);
          fixture.broker.setPaused("transport-thread", true);
          const denied = await rpc("tools/call", {
            name: "computer_type",
            arguments: { text: "must not execute" },
          });
          expect(denied.body.result.isError).toBe(true);
          expect(JSON.stringify(denied.body)).toContain("Interrupted");
          expect(fixture.seen.some((request) => request.op === "type")).toBe(false);
          session.dispose();
          expect((await rpc("tools/list")).status).toBe(401);
        });
      }),
    ),
  );
});
