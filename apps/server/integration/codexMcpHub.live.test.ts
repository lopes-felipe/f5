import { chmod, copyFile, mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ThreadId, type McpProjectServersConfig, type ProviderEvent } from "@t3tools/contracts";
import { translateMcpForCodex } from "@t3tools/shared/mcpTranslation";
import { Effect, Exit, Scope } from "effect";
import { expect, it } from "vitest";

import { CodexAppServerManager } from "../src/codexAppServerManager";
import { makeMcpHub } from "../src/mcp/hub/McpHub";
import { hubEndpointsForCodex } from "../src/mcp/hub/providerHubServers";
import {
  makePreviewAutomationBroker,
  PreviewAutomationBroker,
} from "../src/mcp/PreviewAutomationBroker";
import { makePreviewMcpHttpServer } from "../src/mcp/PreviewMcpHttpServer";

const fixture = fileURLToPath(new URL("../src/mcp/fixtures/hub-server.mjs", import.meta.url));
const SECRET = "codex-hub-live-secret-value-123";

const toolNames = (status: Record<string, unknown> | undefined) =>
  Object.keys((status?.tools as Record<string, unknown> | undefined) ?? {});

// Explicit opt-in. The MCP hub parity gate for Codex: a real Codex app server reaches a
// stdio server through F5's hub endpoint with its credential in `bearer_token_env_var`,
// runs it in the session directory, re-lists tools after `config/mcpServer/reload`
// from the unchanged URL, and never sees the server's secrets.
it.skipIf(process.env.F5_CODEX_LIVE_TEST !== "1")(
  "calls a hub tool with an environment credential and re-lists tools after a reload",
  async () => {
    const binary = process.env.CODEX_BINARY_PATH;
    const sourceHome = process.env.F5_CODEX_CERTIFICATION_HOME ?? process.env.CODEX_HOME;
    if (!binary || !sourceHome)
      throw new Error("Set CODEX_BINARY_PATH and F5_CODEX_CERTIFICATION_HOME (or CODEX_HOME).");
    const temporary = await realpath(await mkdtemp(join(tmpdir(), "f5-codex-mcp-hub-")));
    const home = join(temporary, "home");
    const cwd = join(temporary, "workspace");
    const report = join(temporary, "report.json");
    const scope = Effect.runSync(Scope.make());
    const manager = new CodexAppServerManager();
    const threadId = ThreadId.makeUnsafe("codex-hub-live");
    const events: ProviderEvent[] = [];
    let complete: () => void = () => {};
    const completion = new Promise<void>((resolve) => {
      complete = resolve;
    });
    manager.on("event", (event) => {
      events.push(event);
      if (event.kind === "request" && event.requestId)
        void manager.respondToRequest(threadId, event.requestId, "accept").catch(() => {});
      if (event.method === "turn/completed") complete();
    });
    try {
      await mkdir(home);
      await mkdir(cwd);
      await copyFile(join(sourceHome, "auth.json"), join(home, "auth.json"));
      await chmod(join(home, "auth.json"), 0o600);
      const listener = await Effect.runPromise(
        makePreviewMcpHttpServer.pipe(
          Effect.provideService(PreviewAutomationBroker, makePreviewAutomationBroker()),
          Scope.provide(scope),
        ),
      );
      const hub = makeMcpHub({ listener });
      const servers: McpProjectServersConfig = {
        fixture: {
          type: "stdio",
          command: process.execPath,
          args: [fixture, report],
          env: { HUB_FIXTURE_TOKEN: SECRET },
        },
      };
      const attachment = hub.attach({
        threadId,
        provider: "codex",
        accountKey: "codex-live",
        servers,
        environment: { PATH: process.env.PATH ?? "" },
        cwd,
      });
      try {
        const hubServers = hubEndpointsForCodex(attachment.endpoints, servers);
        const mcpServers =
          translateMcpForCodex(hubServers.servers, {
            ownBearerEnvVars: new Set(Object.keys(hubServers.env)),
          }) ?? {};
        expect(mcpServers.fixture?.bearer_token_env_var).toBe("F5_MCP_HUB_TOKEN_0");
        expect(JSON.stringify(mcpServers)).not.toContain(SECRET);
        await manager.startSession({
          threadId,
          cwd,
          runtimeMode: "full-access",
          disablePlugins: true,
          providerOptions: { codex: { binaryPath: binary, homePath: home } },
          mcpServers,
          mcpEnvironment: hubServers.env,
        });
        await manager.sendTurn({
          threadId,
          input:
            "Call the MCP tool `echo` on the `fixture` server with text `hub-live`, then reply with exactly what it returned. Use no shell or other tools.",
          effort: "low",
        });
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            completion,
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => reject(new Error("Codex hub turn timed out")), 110_000);
            }),
          ]);
        } finally {
          if (timer) clearTimeout(timer);
        }
        expect(JSON.stringify(events)).toContain("echo:hub-live");
        // The stdio server ran in the session directory, started by the hub.
        expect(JSON.parse(await readFile(report, "utf8"))).toMatchObject({ cwd });

        const before = (await manager.reloadMcpConfig(threadId))?.find(
          (status) => status.name === "fixture",
        );
        expect(toolNames(before).some((name) => name.endsWith("echo"))).toBe(true);
        // An Apply that turns a tool off re-binds the same URL; a reload re-lists it.
        attachment.update({ fixture: { ...servers.fixture!, disabledTools: ["echo"] } });
        const after = (await manager.reloadMcpConfig(threadId))?.find(
          (status) => status.name === "fixture",
        );
        expect(toolNames(after).some((name) => name.endsWith("echo"))).toBe(false);
        expect(toolNames(after).some((name) => name.endsWith("ask"))).toBe(true);
      } finally {
        await attachment.dispose();
        await hub.close();
      }
    } finally {
      manager.stopAll();
      await Effect.runPromise(Scope.close(scope, Exit.void));
      await rm(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  },
  180_000,
);
