import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  buildCodexInitializeParams,
  buildCodexThreadOpenRequestParams,
} from "../src/codexAppServerManager";
import { resolveBundledCodexExecutable } from "../src/provider/codexExecutable";
import { buildCodexAppServerCommand } from "../src/provider/codexLaunchArgs";
import { AppServer, asRecord } from "./fixtures/codexAppServer";

// No model, credentials, extension connection or OS input. Opt in to spawning real Codex.
it.skipIf(process.env.F5_CODEX_HANDOFF_PROTOCOL_TEST !== "1")(
  "accepts the browser_resume host tool and MCP reload on the bundled Codex protocol",
  async () => {
    const home = await mkdtemp(join(tmpdir(), "f5-handoff-protocol-"));
    const launch = buildCodexAppServerCommand({
      environment: process.env,
      mcpServers: {
        handoff_fixture: {
          type: "stdio",
          command: process.execPath,
          args: [join(import.meta.dirname, "fixtures", "handoffMcpServer.mjs")],
        },
      },
    });
    const child = spawn(resolveBundledCodexExecutable(), [...launch.argv], {
      cwd: home,
      env: { ...process.env, CODEX_HOME: home },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const server = new AppServer(child, () => {
      throw new Error("No model calls expected.");
    });
    try {
      await server.request("initialize", buildCodexInitializeParams());
      server.notify("initialized");
      const opened = await server.request("thread/start", {
        ...buildCodexThreadOpenRequestParams({
          runtimeMode: "full-access",
          cliVersion: "0.166.0",
          browserResume: true,
          cwd: home,
        }).start,
        ephemeral: true,
      });
      const threadId = asRecord(asRecord(opened)?.thread)?.id;
      expect(typeof threadId).toBe("string");
      const ping = () =>
        server.request("mcpServer/tool/call", {
          threadId,
          server: "handoff_fixture",
          tool: "ping",
          arguments: {},
        });
      expect(await ping()).toMatchObject({ content: [{ type: "text", text: "pong" }] });
      await server.request("config/mcpServer/reload", undefined);
      expect(await ping()).toMatchObject({ content: [{ type: "text", text: "pong" }] });
      await server.request("thread/unsubscribe", { threadId });
      expect(server.serverRequests).toEqual([]);
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
        child.kill();
        await exited;
      }
      await rm(home, { recursive: true, force: true });
    }
  },
  60_000,
);
