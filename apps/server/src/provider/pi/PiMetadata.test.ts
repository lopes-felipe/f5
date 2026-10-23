import { stat } from "node:fs/promises";
import { Effect } from "effect";
import { expect, it } from "vitest";
import { probePiCatalog } from "./PiMetadata.ts";
import { makePiTextGeneration, runPiMetadataPrompt } from "../../git/Layers/PiTextGeneration.ts";
import { PiRpcError } from "./PiRpc.ts";
import { fixture, run } from "./PiMetadata.testkit.ts";

it("probes in a disposable workspace with extensions, tools and inherited MCP credentials disabled", async () =>
  fixture(async (settings, environment, trace) => {
    const catalog = await run(probePiCatalog(settings, environment));
    expect(catalog.models.map((model) => model.slug)).toEqual(["one/shared", "two/shared"]);
    expect(catalog.skills[0]?.name).toBe("review");
    expect(catalog.slashCommands[0]?.name).toBe("compact");
    const spawn = (await trace())[0]!;
    expect((spawn.args as string[]).slice(-3)).toEqual([
      "--no-session",
      "--no-extensions",
      "--no-tools",
    ]);
    expect(spawn.privateEnvironment).toBe(false);
    await expect(stat(String(spawn.cwd))).rejects.toThrow();
  }));
it("fails a broken catalog read instead of replacing a usable catalog with an empty one", async () =>
  fixture(async (settings, environment) => {
    const result = await run(
      probePiCatalog(settings, { ...environment, F5_PI_CASE: "catalog-failure" }).pipe(
        Effect.result,
      ),
    );
    expect(result._tag).toBe("Failure");
    expect(JSON.stringify(result)).not.toContain("PRIVATE_FAILURE");
  }));
it("uses a qualified model and preserves complete assistant output without duplicating deltas", async () =>
  fixture(async (settings, environment, trace) => {
    const text = await run(
      runPiMetadataPrompt({
        settings,
        environment,
        prompt: "title",
        model: "vendor/model/variant",
        thinking: "high",
      }),
    );
    expect(JSON.parse(text)).toEqual({ title: "Inspect Pi metadata", needsRefinement: false });
    const records = await trace();
    expect(records.find((record) => record.type === "set_model")).toMatchObject({
      provider: "vendor",
      modelId: "model/variant",
    });
    expect(records.find((record) => record.type === "set_thinking_level")).toMatchObject({
      level: "high",
    });
    expect(records.filter((record) => record.type === "prompt")).toHaveLength(1);
  }));
it.each(["abort", "error", "tool", "oversize"])(
  "rejects unsuccessful or unsafe metadata outcomes: %s",
  async (mode) =>
    fixture(async (settings, environment, trace) => {
      const result = await run(
        runPiMetadataPrompt({
          settings,
          environment: { ...environment, F5_PI_CASE: mode },
          prompt: "title",
        }).pipe(Effect.result),
      );
      expect(result._tag).toBe("Failure");
      expect((await trace()).some((record) => record.type === "prompt")).toBe(true);
    }),
);
it("clears a recovered model error after a successful native retry", async () =>
  fixture(async (settings, environment) => {
    const text = await run(
      runPiMetadataPrompt({
        settings,
        environment: { ...environment, F5_PI_CASE: "retry" },
        prompt: "title",
      }),
    );
    expect(JSON.parse(text).title).toBe("Inspect Pi metadata");
  }));
it("validates generated JSON through the shared title contract and forwards linked PR context", async () =>
  fixture(async (settings, environment, trace) => {
    const title = await run(
      Effect.gen(function* () {
        const service = yield* makePiTextGeneration(settings, environment);
        return yield* service.generateThreadTitle({
          cwd: "/must-not-be-used",
          message: "Review transport",
          linkedContext: "team/repo#42: Fix native transport",
        });
      }),
    );
    expect(title).toEqual({ title: "Inspect Pi metadata", needsRefinement: false });
    const prompt = (await trace()).find((entry) => entry.type === "prompt");
    expect(prompt?.message).toContain("team/repo#42: Fix native transport");
    expect(prompt?.message).toContain("untrusted data");
    const rejected = await run(
      Effect.gen(function* () {
        const service = yield* makePiTextGeneration(settings, {
          ...environment,
          F5_PI_CASE: "invalid-json",
        });
        return yield* service.generateThreadTitle({
          cwd: "/must-not-be-used",
          message: "Review transport",
        });
      }).pipe(Effect.result),
    );
    expect(rejected._tag).toBe("Failure");
    expect(JSON.stringify(rejected)).not.toContain("PRIVATE_FAILURE");
  }));
it("checks account admission before spawning metadata processes", async () =>
  fixture(async (settings, environment, trace) => {
    const result = await run(
      runPiMetadataPrompt({
        settings,
        environment,
        prompt: "title",
        beforeLaunch: Effect.fail(
          new PiRpcError({ operation: "account", detail: "Account change in progress." }),
        ),
      }).pipe(Effect.result),
    );
    expect(result._tag).toBe("Failure");
    await expect(trace()).rejects.toThrow();
  }));
