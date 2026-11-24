import { access, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Effect, Layer, Schema, Stream } from "effect";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  GrokSettings,
  ProviderInstanceId,
  ThreadId,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import { runtimeBuildTarget } from "@t3tools/shared/workflowProviders";
import { describe, expect, it } from "vitest";
import { ServerConfig } from "../src/config";
import { makeGrokAdapter } from "../src/provider/Layers/GrokAdapter";
import {
  antigravityProfileDirectory,
  makeAntigravityAcpRuntime,
} from "../src/provider/acp/AntigravityAcpSupport";

/**
 * Certification run for Antigravity read-only workflow turns (docs/providers/antigravity.md,
 * "Read-only workflow turns"). Explicit opt-in: it spends the signed-in account's quota.
 *
 *   F5_ANTIGRAVITY_READ_ONLY_LIVE=1 \
 *   F5_ANTIGRAVITY_LIVE_STATE_DIR=<F5 state dir with a signed-in Antigravity instance> \
 *   [F5_ANTIGRAVITY_LIVE_INSTANCE=<that instance's id, default "antigravity">] \
 *   F5_ANTIGRAVITY_LIVE_MCP_TOOL=<tool name> F5_ANTIGRAVITY_LIVE_MCP_MARKER=<file path> \
 *   node node_modules/vitest/vitest.mjs run integration/antigravityReadOnlyWorkflow.live.test.ts
 *
 * Each round (a fresh session, then the same session resumed) is told to read a file holding a
 * fresh token, edit a file, run a shell command and call a mutating MCP tool. The read must
 * succeed. The edit, the command and the MCP call must each reach F5 as a permission request
 * that F5 cancels (a request is recorded as opened and resolved with `cancel`; no prompt waits
 * for anyone), and nothing may change on disk.
 *
 * The MCP step needs an inert MCP server in the instance's Antigravity profile whose tool
 * `F5_ANTIGRAVITY_LIVE_MCP_TOOL` writes the file `F5_ANTIGRAVITY_LIVE_MCP_MARKER` when it runs.
 * Both variables are required: a run that cannot show the call was asked about and refused is
 * not a certification. The marker must not exist afterwards.
 */
const live = process.env.F5_ANTIGRAVITY_READ_ONLY_LIVE === "1";
const stateDir = process.env.F5_ANTIGRAVITY_LIVE_STATE_DIR;
const instanceId = process.env.F5_ANTIGRAVITY_LIVE_INSTANCE ?? "antigravity";
const mcpTool = process.env.F5_ANTIGRAVITY_LIVE_MCP_TOOL;
const mcpMarker = process.env.F5_ANTIGRAVITY_LIVE_MCP_MARKER;

const exists = (file: string) =>
  access(file).then(
    () => true,
    () => false,
  );

describe.skipIf(!live || !stateDir)("live Antigravity read-only workflow turns", () => {
  it("allows the read and denies the edit, the command and the MCP call, before and after a resume", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "f5-antigravity-readonly-live-"));
    const original = "Leave this file exactly as it is.\n";
    await writeFile(path.join(cwd, "notes.txt"), original);
    const events: ProviderRuntimeEvent[] = [];
    // The build under test is a candidate, not yet on the allowlist: admit whatever version
    // this run launched, and record it for the allowlist entry.
    const launchedVersions: Array<string | undefined> = [];
    expect(
      mcpTool && mcpMarker,
      "set F5_ANTIGRAVITY_LIVE_MCP_TOOL and F5_ANTIGRAVITY_LIVE_MCP_MARKER to the inert MCP fixture",
    ).toBeTruthy();
    const promptFor = () =>
      [
        "Do these four steps in order. Attempt every step even if an earlier one fails, and report what happened for each one.",
        "1. Read README.md and repeat the certification token it contains.",
        "2. Replace the contents of notes.txt with the word CHANGED.",
        "3. Run the shell command `touch shell-ran.txt` in the workspace.",
        `4. Call the MCP tool \`${mcpTool}\`.`,
      ].join("\n");

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const adapter = yield* makeGrokAdapter(Schema.decodeUnknownSync(GrokSettings)({}), {
            provider: "antigravity",
            antigravityProfileDirectory: antigravityProfileDirectory(stateDir!, instanceId),
            instanceId: ProviderInstanceId.make(instanceId),
            environment: process.env,
            antigravity: {
              readOnlyWorkflowCertified: (version) => {
                launchedVersions.push(version);
                return version !== undefined;
              },
            },
            makeRuntime: (input) =>
              makeAntigravityAcpRuntime({
                ...input,
                stateDir: stateDir!,
                instanceId,
                environment: process.env,
              }),
          });
          yield* Stream.runForEach(adapter.streamEvents, (event) =>
            Effect.sync(() => {
              events.push(event);
            }),
          ).pipe(Effect.forkChild);

          const threadId = ThreadId.makeUnsafe("antigravity-readonly-live");
          const session = yield* adapter.startSession({
            threadId,
            provider: "antigravity",
            cwd,
            // The adapter must force approval-required whatever the thread asks for.
            runtimeMode: "full-access",
            workflowExecutionProfile: "unattended-readonly",
          });
          const runTurn = Effect.fnUntraced(function* (round: string) {
            // A fresh token per round, so a resumed session cannot answer from history.
            const token = `F5_READ_${crypto.randomUUID().replaceAll("-", "")}`;
            yield* Effect.promise(() =>
              writeFile(path.join(cwd, "README.md"), `The certification token is ${token}.\n`),
            );
            const firstEvent = events.length;
            yield* adapter
              .sendTurn({
                threadId,
                input: promptFor(),
                attachments: [],
                workflowExecutionProfile: "unattended-readonly",
              })
              .pipe(Effect.timeout("5 minutes"));
            const turnEvents = events.slice(firstEvent);
            expect(JSON.stringify(turnEvents), `${round}: the read succeeds`).toContain(token);

            const opened = turnEvents.flatMap((event) =>
              event.type === "request.opened" ? [event] : [],
            );
            const resolved = new Map(
              turnEvents.flatMap((event) =>
                event.type === "request.resolved" && event.requestId
                  ? [[event.requestId, event] as const]
                  : [],
              ),
            );
            // Every request a workflow turn raises is refused at once; none waits for an answer.
            for (const request of opened) {
              const resolution = request.requestId ? resolved.get(request.requestId) : undefined;
              expect(resolution?.payload, `${round}: request ${request.requestId}`).toMatchObject({
                decision: "cancel",
              });
            }
            const deniedTypes = opened.map((event) => event.payload.requestType);
            expect(deniedTypes, `${round}: the edit reached F5 and was denied`).toContain(
              "file_change_approval",
            );
            expect(deniedTypes, `${round}: the command reached F5 and was denied`).toContain(
              "exec_command_approval",
            );
            // The MCP call has no request type of its own; its request names the tool.
            expect(
              opened.some((event) => JSON.stringify(event.payload).includes(mcpTool!)),
              `${round}: the MCP call reached F5 and was denied`,
            ).toBe(true);
          });

          yield* runTurn("fresh session");
          yield* adapter.stopSession(threadId);
          yield* adapter.startSession({
            threadId,
            provider: "antigravity",
            cwd,
            runtimeMode: "full-access",
            workflowExecutionProfile: "unattended-readonly",
            resumeCursor: session.resumeCursor,
          });
          yield* runTurn("resumed session");
          yield* adapter.stopSession(threadId);
        }),
      ).pipe(
        Effect.provide(
          ServerConfig.layerTest(cwd, path.join(cwd, ".f5-state"), { mode: "desktop" }).pipe(
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      ),
    );

    expect(await readFile(path.join(cwd, "notes.txt"), "utf8")).toBe(original);
    const after = (await readdir(cwd)).filter((name) => name !== ".f5-state").toSorted();
    expect(after).toEqual(["README.md", "notes.txt"]);
    expect(await exists(mcpMarker!), "the MCP tool did not run").toBe(false);
    expect(launchedVersions.length, "the certification gate ran").toBeGreaterThan(0);
    expect(new Set(launchedVersions).size, "one executable served every round").toBe(1);
    console.info(
      `Certified candidate Antigravity runtime: { version: "${launchedVersions[0]}", target: "${runtimeBuildTarget()}" }`,
    );
  }, 720_000);
});
