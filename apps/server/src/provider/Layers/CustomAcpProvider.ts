import type { AcpSettings, ServerProviderModel } from "@t3tools/contracts";
import { Effect, FileSystem, Layer } from "effect";
import * as AcpClient from "effect-acp/client";
import { customAcpSpawn } from "../acp/CustomAcpSupport.ts";
import { spawnAcpAgent } from "../acp/AcpSessionRuntime.ts";
import { buildServerProvider, isCommandMissingCause } from "../providerSnapshot.ts";

/** Bounded initialize only: no authentication, session creation, prompt or MCP launch. */
export function probeCustomAcp(config: AcpSettings, environment: NodeJS.ProcessEnv) {
  return Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "f5-acp-probe-" });
      const child = yield* spawnAcpAgent(customAcpSpawn(config, cwd, environment));
      const context = yield* Layer.build(
        AcpClient.layerChildProcess(child, {
          sanitizeStderr: () => "ACP_AGENT_DIAGNOSTIC_OMITTED",
        }),
      );
      const client = yield* Effect.service(AcpClient.AcpClient).pipe(Effect.provide(context));
      return yield* client.agent.initialize({
        protocolVersion: 1,
        clientInfo: { name: "f5-health", version: "1" },
        clientCapabilities: {},
      });
    }),
  ).pipe(Effect.timeout("10 seconds"));
}
export function checkCustomAcpProvider(
  config: AcpSettings,
  environment: NodeJS.ProcessEnv,
  enabled: boolean,
  models: ReadonlyArray<ServerProviderModel>,
) {
  return Effect.gen(function* () {
    const result = enabled
      ? yield* probeCustomAcp(config, environment).pipe(Effect.result)
      : undefined;
    const ready = result?._tag === "Success";
    return buildServerProvider({
      presentation: { displayName: "Custom ACP agent", showInteractionModeToggle: true },
      enabled,
      checkedAt: new Date().toISOString(),
      models,
      probe: {
        installed: ready || (result?._tag === "Failure" && !isCommandMissingCause(result.failure)),
        version: ready ? (result.success.agentInfo?.version ?? null) : null,
        status: ready ? "ready" : "warning",
        auth: { status: "unknown" },
        message: !enabled
          ? "Custom ACP agent is disabled."
          : ready
            ? "ACP initialization succeeded. Authentication is managed by this agent."
            : "ACP initialization failed or exceeded 10 seconds. Check the command and the agent's local setup.",
      },
    });
  });
}
