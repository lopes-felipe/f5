import { copyFile, chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { userInfo } from "node:os";
import { randomUUID } from "node:crypto";
import { query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { ThreadId } from "@t3tools/contracts";
import { translateMcpForCodex } from "@t3tools/shared/mcpTranslation";
import { Effect } from "effect";
import {
  ComputerAutomationBroker,
  ComputerAutomationBrokerRuntime,
} from "../src/computer/ComputerAutomationBroker";
import { DesktopComputerHost } from "../src/computer/DesktopComputerHost";
import { CodexAppServerManager } from "../src/codexAppServerManager";
import { makePreviewMcpHttpServer } from "../src/mcp/PreviewMcpHttpServer";
import {
  makePreviewAutomationBroker,
  PreviewAutomationBroker,
} from "../src/mcp/PreviewAutomationBroker";
import { buildClaudeQueryEnv } from "../src/provider/Layers/ClaudeAdapter";
import { makeClaudeComputerMcpServer } from "../src/provider/Layers/claudeAgentBrowser";
import { rehearsalMcpApproval } from "../integration/computer/rehearsalMcpApproval";

// Only the development rehearsal parent starts this worker with inherited IPC.
// It never installs a built-in backend or changes production certification gates.
const provider = process.env.F5_REHEARSAL_PROVIDER;
const appId = process.env.F5_REHEARSAL_APP_ID;
const root = process.env.F5_REHEARSAL_ROOT;
const profileId = process.env.F5_REHEARSAL_PROFILE_ID;
if (
  process.platform !== "darwin" ||
  process.env.F5_COMPUTER_PROVIDER_REHEARSAL !== "1" ||
  process.env.F5_DESKTOP_COMPUTER_HOST !== "ipc" ||
  !process.send ||
  (provider !== "claude" && provider !== "codex") ||
  !appId?.startsWith("org.example.computer-rehearsal.") ||
  !root ||
  !profileId
)
  throw new Error("Start this worker through rehearseProviderMacos.ts with explicit opt-in.");

const threadId = ThreadId.makeUnsafe(randomUUID());
const turnId = "native-rehearsal-turn";
const host = DesktopComputerHost.fromEnvironment(profileId);
const broker = new ComputerAutomationBrokerRuntime(host, {
  platform: "darwin",
  resolve: async (thread, sessionGeneration) => ({
    threadId: thread,
    sessionGeneration,
    provider,
    projectId: "synthetic-rehearsal",
    turnId,
    threadTitle: `${provider} native rehearsal`,
    runtimeMode: "approval-required",
    interactionMode: "default",
    policy: {
      computerUse: true,
      claudeInChrome: false,
      codexChrome: false,
      previewAutomation: false,
      externalHosts: [],
    },
  }),
  storage: { load: async () => [], save: async () => {} },
});
const cwd = join(root, `workspace-${provider}`);
await mkdir(cwd);
await broker.initialize();
const prompt = `This is an explicitly authorized unsigned development rehearsal. You may control ONLY the synthetic app with exact ID ${appId}. Use only F5 computer tools. Call computer_status, request access for that exact app ID with reason Synthetic native rehearsal, activate it, take a computer_screenshot, and inspect it. Use elementAction press on the button named Rehearsal press exactly once. Use elementAction focus on Rehearsal input, then computer_type exactly this synthetic text: F5_PROVIDER_REHEARSAL Ω🙂. Inspect to verify the press counter and input, then finish with READY. Never touch the secure field. Do not use shell, filesystem, network or other tools. On any Interrupted, OutcomeUnknown or failed action stop immediately without retrying.`;
const approvalMethods: string[] = [];
const approvalDecisions: string[] = [];
let interrupted = false;
let stopProvider = () => {};
const offHost = host.onMessage((message) => {
  if (
    (message.type === "pauseChanged" && message.paused) ||
    (message.type === "status" && !message.status.available)
  ) {
    interrupted = true;
    stopProvider();
  }
});
const stopInterrupted = () => {
  interrupted = true;
  stopProvider();
};
process.once("disconnect", stopInterrupted);
process.once("SIGINT", stopInterrupted);
process.once("SIGTERM", stopInterrupted);
const deadline = setTimeout(() => {
  interrupted = true;
  stopProvider();
}, 150000);
const started = performance.now();
let stage = "host-ready";
let failureStage: string | undefined;
let failureName: string | undefined;
let completed = false;
let model = "";
let modelReceivedImage = false;
let resultSubtype: string | undefined;
let authenticationRejected = false;
try {
  const waitUntil = Date.now() + 5000;
  while (!host.status().available) {
    if (Date.now() > waitUntil || !host.hasHost()) throw new Error("Desktop host unavailable.");
    await new Promise<void>((done) => setTimeout(done, 25));
  }
  if (provider === "claude") {
    const computer = makeClaudeComputerMcpServer({
      broker,
      threadId,
      existingServerNames: new Set(),
    });
    model = process.env.F5_CLAUDE_COMPUTER_MODEL ?? "claude-fable-5-1";
    let endInput = () => {};
    const inputClosed = new Promise<void>((done) => {
      endInput = done;
    });
    const input: AsyncIterable<SDKUserMessage> = {
      async *[Symbol.asyncIterator]() {
        yield {
          type: "user",
          parent_tool_use_id: null,
          message: { role: "user", content: prompt },
        };
        // Keep SDK input open while its in-process MCP tools are executing.
        await inputClosed;
      },
    };
    const q = query({
      prompt: input,
      options: {
        cwd,
        model,
        persistSession: false,
        executable: "node",
        settingSources: [],
        maxTurns: 18,
        env: buildClaudeQueryEnv(
          { subagentModel: "inherit" },
          {
            ...process.env,
            HOME: userInfo().homedir,
            USER: userInfo().username,
          },
        ),
        mcpServers: { [computer.serverName]: computer.config },
        extraArgs: { "no-chrome": null },
        canUseTool: async (name, toolInput, options) =>
          (name.startsWith(`mcp__${computer.serverName}__`) &&
            options.mcpServer?.source === "sdk") ||
          name === "ToolSearch"
            ? { behavior: "allow", updatedInput: toolInput }
            : {
                behavior: "deny",
                message: "Only the synthetic F5 computer rehearsal is authorized.",
              },
      },
    });
    stopProvider = () => {
      q.close();
      endInput();
    };
    try {
      stage = "claude-initialization";
      await q.initializationResult();
      stage = "claude-provenance";
      const status = (await q.mcpServerStatus()).find((item) => item.name === computer.serverName);
      if (status?.source !== "sdk") throw new Error("Computer server provenance was not verified.");
      stage = "claude-turn";
      for await (const message of q) {
        if (message.type === "user" && Array.isArray(message.message.content))
          modelReceivedImage ||= message.message.content.some(
            (block) =>
              block.type === "tool_result" &&
              Array.isArray(block.content) &&
              block.content.some((part) => part.type === "image"),
          );
        if (message.type === "result") {
          resultSubtype = message.subtype;
          authenticationRejected =
            message.subtype === "success" && message.result.includes("Not logged in");
          completed = message.subtype === "success" && message.result.includes("READY");
          break;
        }
      }
      computer.endTurn?.(turnId);
    } finally {
      stopProvider();
      computer.dispose?.();
    }
  } else {
    const binary = process.env.CODEX_BINARY_PATH;
    const sourceHome = process.env.F5_CODEX_CERTIFICATION_HOME ?? process.env.CODEX_HOME;
    if (!binary || !sourceHome)
      throw new Error("Set CODEX_BINARY_PATH and F5_CODEX_CERTIFICATION_HOME.");
    const home = join(root, "codex-home");
    await mkdir(home);
    await copyFile(join(sourceHome, "auth.json"), join(home, "auth.json"));
    await chmod(join(home, "auth.json"), 0o600);
    const manager = new CodexAppServerManager();
    const preview = makePreviewAutomationBroker();
    model = process.env.F5_CODEX_COMPUTER_MODEL ?? "gpt-6.1-sol";
    let finish = () => {};
    const completion = new Promise<void>((done) => {
      finish = done;
    });
    stopProvider = () => {
      manager.stopAll();
      finish();
    };
    let computerServerName: string | undefined;
    manager.on("event", (event) => {
      if (event.kind === "request" && event.requestId) {
        approvalMethods.push(event.method);
        const decision = computerServerName
          ? rehearsalMcpApproval(event.method, event.payload, computerServerName)
          : "decline";
        approvalDecisions.push(decision);
        void manager.respondToRequest(threadId, event.requestId, decision).catch(() => {});
      }
      if (event.method === "turn/completed") {
        const payload = event.payload as { turn?: { status?: string } } | undefined;
        completed = payload?.turn?.status === "completed";
        finish();
      }
    });
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            yield* Effect.addFinalizer(() => preview.shutdown);
            const server = yield* makePreviewMcpHttpServer.pipe(
              Effect.provideService(PreviewAutomationBroker, preview),
              Effect.provideService(ComputerAutomationBroker, broker),
            );
            const session = server.createSessionConfig({ threadId, catalog: "computer" });
            computerServerName = session.serverName;
            yield* Effect.promise(async () => {
              try {
                stage = "codex-initialization";
                await manager.startSession({
                  threadId,
                  cwd,
                  model,
                  runtimeMode: "approval-required",
                  disablePlugins: true,
                  providerOptions: { codex: { binaryPath: binary, homePath: home } },
                  mcpServers:
                    translateMcpForCodex({ [session.serverName]: session.serverDefinition }) ?? {},
                  mcpEnvironment: session.env,
                });
                stage = "codex-turn";
                await manager.sendTurn({ threadId, input: prompt, effort: "low" });
                await completion;
              } finally {
                session.dispose();
              }
            });
          }),
        ),
      );
    } finally {
      manager.stopAll();
      await rm(home, { recursive: true, force: true });
    }
  }
  if (!completed || interrupted) throw new Error("Provider did not complete the native rehearsal.");
} catch (error) {
  failureStage = stage;
  failureName =
    error instanceof Error && ["Error", "TypeError", "AbortError"].includes(error.name)
      ? error.name
      : "Unknown";
  process.exitCode = 1;
} finally {
  clearTimeout(deadline);
  offHost();
  process.off("SIGINT", stopInterrupted);
  process.off("SIGTERM", stopInterrupted);
  stopProvider();
  broker.endTurn(threadId, turnId);
  broker.close();
  await writeFile(
    join(root, `${provider}-result.json`),
    JSON.stringify({
      provider,
      model,
      ...(failureStage ? { failureStage, failureName } : {}),
      completed,
      interrupted,
      ...(provider === "claude" ? { modelReceivedImage, resultSubtype } : {}),
      authenticationRejected,
      additionalApprovalMethods: approvalMethods,
      additionalApprovalDecisions: approvalDecisions,
      elapsedMs: Math.round(performance.now() - started),
    }),
  );
  await rm(cwd, { recursive: true, force: true });
  process.disconnect?.();
}
