import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { CodexConfigurationService } from "../src/codex/CodexConfigurationService";
import { CodexControlClient } from "../src/codex/CodexControlClient";
import { resolveBundledCodexExecutable } from "../src/provider/codexExecutable";

// No credentials, model calls, or changes to existing provider homes.
it.skipIf(process.env.F5_CODEX_CONFIG_LIVE_TEST !== "1")(
  "round-trips native provider configuration, media opt-ins, and saved thread provider bindings",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "f5-codex-config-live-"));
    const environment = { cwd: root, homePath: root, binaryPath: resolveBundledCodexExecutable() };
    const service = new CodexConfigurationService(environment);
    let client: CodexControlClient | undefined;
    try {
      expect((await service.execute({ type: "read" })).features).toEqual({
        audio: false,
        animation: false,
      });
      await service.execute({ type: "setFeature", feature: "audio", enabled: true });
      expect(
        (await service.execute({ type: "setFeature", feature: "animation", enabled: true }))
          .features,
      ).toEqual({ audio: true, animation: true });
      const configured = await service.execute({
        type: "write",
        settings: { type: "customGateway", name: "F5 fixture", baseUrl: "http://127.0.0.1:1/v1" },
      });
      const cloud = await service.execute({
        type: "write",
        settings: {
          type: "gcp",
          providerId: "gcp",
          projectId: "f5-fixture",
          location: "us-central1",
        },
      });
      expect(cloud.providers?.data.find((row) => row.id === "gcp")?.settings).toMatchObject({
        type: "gcp",
        projectId: "f5-fixture",
        location: "us-central1",
      });
      const aws = await service.execute({
        type: "write",
        settings: {
          type: "bedrock",
          providerId: "amazon-bedrock-runtime",
          profile: "f5-fixture",
          region: "us-east-1",
        },
      });
      expect(
        aws.providers?.data.find((row) => row.id === "amazon-bedrock-runtime")?.settings,
      ).toMatchObject({ type: "bedrock", profile: "f5-fixture", region: "us-east-1" });
      const provider = configured.providers?.data.find((row) => row.name === "F5 fixture");
      expect(provider?.settings.type).toBe("customGateway");
      await service.execute({ type: "setDefault", providerId: provider!.id });
      client = await CodexControlClient.create(environment, undefined, { probeConfigRead: true });
      const created = (await client.configurationRequest("thread/start", { cwd: root })) as {
        thread: { id: string; modelProvider: string };
      };
      expect(created.thread.modelProvider).toBe(provider!.id);
      // Codex persists a rollout lazily on the first submitted turn. This gateway
      // points at a closed loopback port, so no model or external service is used.
      const turn = (await client.configurationRequest("turn/start", {
        threadId: created.thread.id,
        input: [{ type: "text", text: "Fixture", text_elements: [] }],
      })) as { turn: { id: string } };
      await client
        .configurationRequest("turn/interrupt", {
          threadId: created.thread.id,
          turnId: turn.turn.id,
        })
        .catch((error: unknown) => {
          if (!(error instanceof Error) || !error.message.includes("no active turn to interrupt"))
            throw error;
        });
      await service.execute({ type: "setDefault", providerId: "openai" });
      await client.closeAndWait();
      client = await CodexControlClient.create(
        {
          ...environment,
          launchArgs: ["-c", 'model_provider="openai"'],
        },
        undefined,
        { probeConfigRead: true },
      );
      const resumed = (await client.configurationRequest("thread/resume", {
        threadId: created.thread.id,
      })) as {
        thread: { modelProvider: string };
      };
      expect(resumed.thread.modelProvider).toBe(provider!.id);
      const unchanged = await service.execute({
        type: "write",
        settings: {
          type: "customGateway",
          providerId: provider!.id,
          name: "Renamed fixture",
        },
      });
      expect(unchanged.providers?.data.find((row) => row.id === provider!.id)?.baseUrl).toBe(
        "http://127.0.0.1:1/v1",
      );
    } finally {
      await client?.closeAndWait();
      await service.close();
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  },
  30_000,
);
