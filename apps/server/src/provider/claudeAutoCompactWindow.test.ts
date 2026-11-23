import { expect, it } from "vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, FileSystem, Path } from "effect";
import { resolveClaudeAutoCompactWindow } from "./claudeAutoCompactWindow.ts";

it("resolves Claude's compaction setting in launch, environment, local, project and user order", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped();
      const cwd = path.join(root, "project");
      const configDirectory = path.join(root, "profile");
      const projectSettings = path.join(cwd, ".claude");
      yield* fs.makeDirectory(projectSettings, { recursive: true });
      yield* fs.makeDirectory(configDirectory);
      const localFile = path.join(projectSettings, "settings.local.json");
      const save = (file: string, settings: unknown) =>
        fs.writeFileString(file, JSON.stringify(settings));
      const input = {
        cwd,
        configDirectory,
        homeDirectory: root,
        platform: "darwin",
        environment: {},
        model: "gateway-model[1m]",
      } as const;
      const resolve = resolveClaudeAutoCompactWindow(input);

      yield* save(path.join(configDirectory, "settings.json"), { autoCompactWindow: 140_000 });
      expect(yield* resolve).toBe(140_000);
      yield* save(path.join(projectSettings, "settings.json"), { autoCompactWindow: 150_000 });
      expect(yield* resolve).toBe(150_000);
      yield* save(localFile, {
        modelSettings: { "gateway-model": { autoCompactWindow: 160_000 } },
      });
      expect(yield* resolve).toBe(160_000);
      yield* save(localFile, { modelSettings: { "gateway-model": { autoCompactWindow: "auto" } } });
      expect(yield* resolve).toBeUndefined();
      const envInput = { ...input, environment: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: "170000" } };
      expect(yield* resolveClaudeAutoCompactWindow(envInput)).toBe(170_000);
      const override = { ...envInput, launchSettings: { autoCompactWindow: 180_000 } };
      expect(yield* resolveClaudeAutoCompactWindow(override)).toBe(180_000);
      yield* save(localFile, { autoCompactEnabled: false });
      expect(yield* resolveClaudeAutoCompactWindow(override)).toBeUndefined();
      yield* save(localFile, { env: { DISABLE_AUTO_COMPACT: "true" } });
      expect(yield* resolveClaudeAutoCompactWindow(override)).toBeUndefined();
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
