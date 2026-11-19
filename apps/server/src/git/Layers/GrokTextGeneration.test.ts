import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { GrokSettings, ProviderInstanceId } from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { Effect, FileSystem, Schema } from "effect";
import { expect } from "vitest";

import { writeCliScript } from "../../testUtils/cli.ts";
import { makeGrokTextGeneration } from "./GrokTextGeneration.ts";
import { makeGrokAcpRuntime } from "../../provider/acp/GrokAcpSupport.ts";

for (const customRuntime of [false, true]) {
  it.effect(`cancels background tool requests with custom runtime=${customRuntime}`, () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "f5-grok-text-" });
      const log = dir + "/permission.json";
      const binaryPath = writeCliScript(
        dir + "/grok",
        String.raw`
const fs = require("node:fs");
const readline = require("node:readline");
const expectedArgs = process.env.F5_CUSTOM_RUNTIME === "1"
  ? ["agent", "stdio"]
  : ["--permission-mode", "default", "agent", "stdio"];
if (JSON.stringify(process.argv.slice(2)) !== JSON.stringify(expectedArgs)) {
  throw new Error("background generation inherited permission config");
}
const write = (value) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...value }) + "\n");
let promptId;
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  if (request.id === 9001 && !request.method) {
    fs.writeFileSync(process.env.F5_PERMISSION_LOG, JSON.stringify(request.result));
    write({ method: "session/update", params: { sessionId: "text-session", update: {
      sessionUpdate: "agent_message_chunk", content: { type: "text", text: '{"subject":"Safe commit","body":""}' }
    } } });
    write({ id: promptId, result: { stopReason: "end_turn" } });
    return;
  }
  if (request.id === undefined) return;
  let result = {};
  if (request.method === "initialize") result = { protocolVersion: 1, agentCapabilities: {} };
  if (request.method === "session/new") result = { sessionId: "text-session" };
  if (request.method === "session/prompt") {
    promptId = request.id;
    write({ id: 9001, method: "session/request_permission", params: {
      sessionId: "text-session",
      toolCall: { toolCallId: "tool-1", kind: "execute", title: "Run a command from the diff" },
      options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }]
    } });
    return;
  }
  write({ id: request.id, result });
});
`,
      );
      const generator = yield* makeGrokTextGeneration(
        Schema.decodeSync(GrokSettings)({ binaryPath }),
        { ...process.env, F5_PERMISSION_LOG: log, F5_CUSTOM_RUNTIME: customRuntime ? "1" : "0" },
        customRuntime
          ? {
              // A custom runtime need not honor the Grok mode hint. The shared
              // permission handler must still cancel requests before prompting.
              makeRuntime: (input) => {
                const { runtimeMode, ...runtimeInput } = input;
                expect(runtimeMode).toBe("approval-required");
                return makeGrokAcpRuntime(runtimeInput);
              },
              normalizeModel: (model) => model,
              defaultModelSelection: createModelSelection(
                ProviderInstanceId.make("custom-acp"),
                "grok-build",
              ),
            }
          : undefined,
      );
      const result = yield* generator.generateCommitMessage({
        cwd: dir,
        branch: "feature",
        stagedSummary: "1 file changed",
        stagedPatch: "untrusted diff text",
      });
      expect(result.subject).toBe("Safe commit");
      expect(JSON.parse(yield* fs.readFileString(log))).toEqual({
        outcome: { outcome: "cancelled" },
      });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
}
