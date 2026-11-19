import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  ORCHESTRATION_WS_METHODS,
  WS_METHODS,
  type AgentSessionImportResult,
  type AgentSessionScanResult,
  type OrchestrationReadModel,
} from "@t3tools/contracts";
import {
  connectAndAwaitWelcome,
  createWsServerTestHarness,
  sendRequest,
} from "./wsServer.testHarness";

describe("onboarding agent history RPCs", () => {
  const h = createWsServerTestHarness();
  it("discovers configured homes and persists an idle resumable thread without duplicating a retry", async () => {
    const root = fs.realpathSync(h.makeTempDir("f5-agent-import-rpc-"));
    const stateDir = path.join(root, "state");
    // Win32 normalizes trailing spaces in actual directory names.
    const suffix = process.platform === "win32" ? "" : " ";
    const home = path.join(root, "codex" + suffix);
    const cwd = path.join(root, "project" + suffix);
    for (const folder of [stateDir, path.join(home, "sessions"), cwd])
      fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(
      path.join(stateDir, "settings.json"),
      JSON.stringify({
        providers: {
          codex: { homePath: home },
          claudeAgent: { homePath: path.join(root, "claude") },
        },
      }),
    );
    fs.writeFileSync(
      path.join(home, "sessions", "native.jsonl"),
      [
        { type: "session_meta", payload: { id: "11111111-1111-4111-8111-111111111111", cwd } },
        { type: "event_msg", payload: { type: "user_message", message: "My original prompt" } },
        {
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "My original answer" }],
          },
        },
      ]
        .map((row) => JSON.stringify(row))
        .join("\n") + "\n",
    );
    h.server = await h.createTestServer({
      stateDir,
      cwd: root,
      autoBootstrapProjectFromCwd: false,
    });
    const address = h.server.address();
    const [ws] = await connectAndAwaitWelcome(
      typeof address === "object" && address ? address.port : 0,
    );
    h.connections.push(ws);
    const discovery = await sendRequest(ws, WS_METHODS.projectsScanAgentSessions);
    expect(discovery.error).toBeUndefined();
    const scan = discovery.result as AgentSessionScanResult;
    expect(scan.candidates).toHaveLength(1);
    const candidate = scan.candidates[0]!;
    expect(candidate.path).toBe(fs.realpathSync(cwd));
    const input = {
      candidateId: candidate.id,
      expectedWorkspaceRoot: candidate.path,
      includeHistory: true,
    };
    const first = await sendRequest(ws, WS_METHODS.projectsImportAgentSessions, input);
    expect(first.error).toBeUndefined();
    const imported = first.result as AgentSessionImportResult;
    expect(imported.threadIds).toHaveLength(1);
    const retry = await sendRequest(ws, WS_METHODS.projectsImportAgentSessions, input);
    expect(retry.result).toEqual(imported);
    const snapshot = (await sendRequest(ws, ORCHESTRATION_WS_METHODS.getSnapshot))
      .result as OrchestrationReadModel;
    expect(snapshot.projects).toHaveLength(1);
    expect(snapshot.threads).toHaveLength(1);
    expect(snapshot.threads[0]).toMatchObject({
      runtimeMode: "approval-required",
      branch: null,
      worktreePath: null,
      modelSelection: { instanceId: "codex" },
      session: null,
    });
    expect(snapshot.threads[0]?.messages.map((message) => message.text)).toEqual([
      "My original prompt",
      "My original answer",
    ]);
  });
});
