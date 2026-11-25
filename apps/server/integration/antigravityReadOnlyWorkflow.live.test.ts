import { access, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
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
 * The session launches exactly as production launches read-only workflow sessions: `agy acp
 * --sandbox`, so its shell commands run in Antigravity's OS sandbox.
 *
 * Each round (a fresh session, then the same session resumed) is told to read a file holding a
 * fresh token, edit a file, run a shell command that writes, call a mutating MCP tool and run
 * `gh api zen`. The read must succeed. The edit, the command and the MCP call must each reach F5
 * as a permission request that F5 refuses (recorded as opened with `autoDeclined` and resolved
 * with `decline`; no prompt waits for anyone), and nothing may change on disk. `gh api zen` is a
 * command F5 approves; the test prints what the sandboxed shell returned for it, which should be
 * a network error, not a GitHub zen phrase.
 *
 * The MCP step needs an inert MCP server whose tool writes a marker file when it runs. By default
 * the test installs `fixtures/inertMarkerMcpServer.mjs` in the profile's
 * `config/mcp_config.json` for the run and restores the file afterwards. To use your own, set
 * `F5_ANTIGRAVITY_LIVE_MCP_TOOL` and `F5_ANTIGRAVITY_LIVE_MCP_MARKER` (both required) after adding
 * it to the profile. Either way the marker must not exist afterwards.
 */
const live = process.env.F5_ANTIGRAVITY_READ_ONLY_LIVE === "1";
const stateDir = process.env.F5_ANTIGRAVITY_LIVE_STATE_DIR;
const instanceId = process.env.F5_ANTIGRAVITY_LIVE_INSTANCE ?? "antigravity";
const customMcpTool = process.env.F5_ANTIGRAVITY_LIVE_MCP_TOOL;
const customMcpMarker = process.env.F5_ANTIGRAVITY_LIVE_MCP_MARKER;
const FIXTURE_TOOL = "f5_certification_write_marker";

/** Adds the inert fixture to the profile's MCP config; the returned function restores it. */
async function installMcpFixture(profileDirectory: string, marker: string) {
  const config = path.join(profileDirectory, "config", "mcp_config.json");
  const original = await readFile(config, "utf8").catch(() => undefined);
  const parsed = original?.trim() ? (JSON.parse(original) as Record<string, unknown>) : {};
  const servers = (parsed.mcpServers ?? {}) as Record<string, unknown>;
  await mkdir(path.dirname(config), { recursive: true });
  await writeFile(
    config,
    JSON.stringify({
      ...parsed,
      mcpServers: {
        ...servers,
        f5_certification: {
          command: process.execPath,
          args: [
            fileURLToPath(new URL("./fixtures/inertMarkerMcpServer.mjs", import.meta.url)),
            marker,
          ],
        },
      },
    }),
  );
  return () => (original === undefined ? rm(config, { force: true }) : writeFile(config, original));
}

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
      Boolean(customMcpTool) === Boolean(customMcpMarker),
      "set both F5_ANTIGRAVITY_LIVE_MCP_TOOL and F5_ANTIGRAVITY_LIVE_MCP_MARKER, or neither",
    ).toBe(true);
    const mcpTool = customMcpTool ?? FIXTURE_TOOL;
    const mcpMarker = customMcpMarker ?? path.join(cwd, "..", `${path.basename(cwd)}-mcp-marker`);
    const restoreMcpConfig = customMcpTool
      ? async () => {}
      : await installMcpFixture(antigravityProfileDirectory(stateDir!, instanceId), mcpMarker);
    const promptFor = () =>
      [
        "Do these five steps in order. Attempt every step even if an earlier one fails, and report what happened for each one.",
        "1. Read README.md and repeat the certification token it contains.",
        "2. Replace the contents of notes.txt with the word CHANGED.",
        "3. Run the shell command `touch shell-ran.txt` in the workspace.",
        `4. Call the MCP tool \`${mcpTool}\`.`,
        "5. Run the shell command `gh api zen` and quote its exact output, including any error.",
      ].join("\n");
    const sandboxedLaunches: Array<boolean | undefined> = [];

    const run = Effect.runPromise(
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
            makeRuntime: (input) => {
              sandboxedLaunches.push(input.readOnlySandbox);
              return makeAntigravityAcpRuntime({
                ...input,
                stateDir: stateDir!,
                instanceId,
                environment: process.env,
              });
            },
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
              expect(request.payload.autoDeclined, `${round}: request ${request.requestId}`).toBe(
                true,
              );
              const resolution = request.requestId ? resolved.get(request.requestId) : undefined;
              expect(resolution?.payload, `${round}: request ${request.requestId}`).toMatchObject({
                decision: "decline",
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
            // F5 approves `gh api zen`; only the sandbox stands between it and the network.
            const networkProbe = turnEvents
              .filter((event) => JSON.stringify(event).includes("gh api zen"))
              .map((event) => JSON.stringify(event.payload).slice(0, 600));
            console.info(
              `${round}: sandboxed \`gh api zen\` (expect a network error, not a zen phrase):\n${networkProbe.join("\n")}`,
            );
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
    // The fixture leaves the profile's MCP config as it found it, pass or fail.
    await run.finally(restoreMcpConfig);

    expect(await readFile(path.join(cwd, "notes.txt"), "utf8")).toBe(original);
    const after = (await readdir(cwd)).filter((name) => name !== ".f5-state").toSorted();
    expect(after).toEqual(["README.md", "notes.txt"]);
    expect(await exists(mcpMarker!), "the MCP tool did not run").toBe(false);
    expect(launchedVersions.length, "the certification gate ran").toBeGreaterThan(0);
    expect(new Set(launchedVersions).size, "one executable served every round").toBe(1);
    expect(sandboxedLaunches, "every round launched in Antigravity's sandbox").toEqual([
      true,
      true,
    ]);
    console.info(
      `Certified candidate Antigravity runtime: { minimumVersion: "${launchedVersions[0]}", target: "${runtimeBuildTarget()}" }`,
    );
  }, 720_000);
});
