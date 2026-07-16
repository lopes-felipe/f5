import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Path, Schema } from "effect";

import { CodexSettings } from "@t3tools/contracts";
import {
  CODEX_SHADOW_MANAGED_FILES_MANIFEST,
  CodexShadowHomeError,
  materializeCodexShadowHome,
  normalizeWindowsLinkPath,
  resolveCodexHomeLayout,
} from "./CodexHomeLayout.ts";

const decodeCodexSettings = (input: {
  readonly enabled?: boolean;
  readonly homePath?: string;
  readonly shadowHomePath?: string;
  readonly customModels?: readonly string[];
  readonly binaryPath?: string;
}): CodexSettings => Schema.decodeSync(CodexSettings)(input);

const makeTempDir = Effect.fn("CodexHomeLayout.test.makeTempDir")(function* (prefix: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.makeTempDirectoryScoped({ prefix });
});

const writeTextFile = Effect.fn("CodexHomeLayout.test.writeTextFile")(function* (
  filePath: string,
  contents: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fileSystem.makeDirectory(path.dirname(filePath), { recursive: true });
  yield* fileSystem.writeFileString(filePath, contents);
});

it.layer(NodeServices.layer)("CodexHomeLayout", (it) => {
  it("normalizes Windows junction targets for stable drift checks", () => {
    expect(normalizeWindowsLinkPath("\\\\?\\C:\\Users\\Test\\Codex\\")).toBe(
      "c:\\users\\test\\codex",
    );
    expect(normalizeWindowsLinkPath("c:/users/test/codex")).toBe("c:\\users\\test\\codex");
    expect(normalizeWindowsLinkPath("\\\\?\\UNC\\Server\\Share\\Codex\\")).toBe(
      "\\\\server\\share\\codex",
    );
  });

  describe("resolveCodexHomeLayout", () => {
    it.effect("uses direct CODEX_HOME when no shadow home is configured", () =>
      Effect.gen(function* () {
        const homePath = yield* makeTempDir("t3code-codex-home-");

        const layout = yield* resolveCodexHomeLayout(
          decodeCodexSettings({
            homePath,
          }),
        );

        expect(layout).toMatchObject({
          mode: "direct",
          sharedHomePath: homePath,
          effectiveHomePath: homePath,
          continuationKey: `codex:home:${homePath}`,
        });
      }),
    );

    it.effect("uses the shared home for continuation and the shadow home for runtime", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const sharedHome = yield* makeTempDir("t3code-codex-shared-");
        const shadowRoot = yield* makeTempDir("t3code-codex-shadow-root-");
        const shadowHome = path.join(shadowRoot, "shadow");

        const layout = yield* resolveCodexHomeLayout(
          decodeCodexSettings({
            homePath: sharedHome,
            shadowHomePath: shadowHome,
          }),
        );

        expect(layout).toMatchObject({
          mode: "authOverlay",
          sharedHomePath: sharedHome,
          effectiveHomePath: shadowHome,
          continuationKey: `codex:home:${sharedHome}`,
        });
      }),
    );
  });

  describe("materializeCodexShadowHome", () => {
    it.effect("materializes a shadow home with shared state links and private auth", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const sharedHome = yield* makeTempDir("t3code-codex-shared-");
        const shadowRoot = yield* makeTempDir("t3code-codex-shadow-root-");
        const shadowHome = path.join(shadowRoot, "shadow");

        yield* fileSystem.makeDirectory(path.join(sharedHome, "sessions"));
        yield* writeTextFile(path.join(sharedHome, "config.toml"), 'model = "gpt-5-codex"\n');
        yield* writeTextFile(path.join(sharedHome, "models_cache.json"), '{"models":["shared"]}\n');
        yield* writeTextFile(path.join(sharedHome, "auth.json"), '{"shared":true}\n');
        yield* fileSystem.makeDirectory(shadowHome, { recursive: true });
        yield* writeTextFile(path.join(shadowHome, "auth.json"), '{"shadow":true}\n');
        if (process.platform !== "win32") {
          yield* fileSystem.symlink(
            path.join(sharedHome, "models_cache.json"),
            path.join(shadowHome, "models_cache.json"),
          );
        }

        const layout = yield* resolveCodexHomeLayout(
          decodeCodexSettings({
            homePath: sharedHome,
            shadowHomePath: shadowHome,
          }),
        );

        yield* materializeCodexShadowHome(layout);
        yield* materializeCodexShadowHome(layout);

        const sessionsTarget = yield* fileSystem.readLink(path.join(shadowHome, "sessions"));
        const configPath = path.join(shadowHome, "config.toml");
        const sharedConfigPath = path.join(sharedHome, "config.toml");
        const modelsCacheExists = yield* fileSystem.exists(
          path.join(shadowHome, "models_cache.json"),
        );
        const authLinkResult = yield* fileSystem
          .readLink(path.join(shadowHome, "auth.json"))
          .pipe(Effect.result);
        const authContents = yield* fileSystem.readFileString(path.join(shadowHome, "auth.json"));

        if (process.platform === "win32") {
          expect(normalizeWindowsLinkPath(sessionsTarget)).toBe(
            normalizeWindowsLinkPath(path.join(sharedHome, "sessions")),
          );
          const [configStat, sharedConfigStat] = yield* Effect.all([
            fileSystem.stat(configPath),
            fileSystem.stat(sharedConfigPath),
          ]);
          expect(configStat.ino).toBe(sharedConfigStat.ino);
          yield* fileSystem.writeFileString(sharedConfigPath, 'model = "gpt-5.1-codex"\n');
          expect(yield* fileSystem.readFileString(configPath)).toContain("gpt-5.1-codex");
        } else {
          expect(sessionsTarget).toBe(path.join(sharedHome, "sessions"));
          expect(yield* fileSystem.readLink(configPath)).toBe(sharedConfigPath);
        }
        expect(modelsCacheExists).toBe(false);
        expect(authLinkResult._tag).toBe("Failure");
        expect(authContents).toContain("shadow");
      }),
    );

    it.effect("accepts Codex-created shadow-local runtime directories", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const sharedHome = yield* makeTempDir("t3code-codex-shared-");
        const shadowRoot = yield* makeTempDir("t3code-codex-shadow-root-");
        const shadowHome = path.join(shadowRoot, "shadow");

        yield* fileSystem.makeDirectory(path.join(sharedHome, "log"));
        yield* fileSystem.makeDirectory(path.join(sharedHome, "memories"));
        yield* fileSystem.makeDirectory(path.join(sharedHome, "tmp"));
        yield* writeTextFile(path.join(sharedHome, "config.toml"), 'model = "gpt-5-codex"\n');
        yield* writeTextFile(path.join(shadowHome, "auth.json"), '{"shadow":true}\n');
        yield* fileSystem.makeDirectory(path.join(shadowHome, "log"), { recursive: true });
        yield* fileSystem.makeDirectory(path.join(shadowHome, "memories"), { recursive: true });
        yield* fileSystem.makeDirectory(path.join(shadowHome, "tmp"), { recursive: true });

        const layout = yield* resolveCodexHomeLayout(
          decodeCodexSettings({
            homePath: sharedHome,
            shadowHomePath: shadowHome,
          }),
        );

        yield* materializeCodexShadowHome(layout);

        const configPath = path.join(shadowHome, "config.toml");
        const logLinkResult = yield* fileSystem
          .readLink(path.join(shadowHome, "log"))
          .pipe(Effect.result);
        const memoriesLinkResult = yield* fileSystem
          .readLink(path.join(shadowHome, "memories"))
          .pipe(Effect.result);
        const tmpLinkResult = yield* fileSystem
          .readLink(path.join(shadowHome, "tmp"))
          .pipe(Effect.result);

        if (process.platform === "win32") {
          const [configStat, sharedConfigStat] = yield* Effect.all([
            fileSystem.stat(configPath),
            fileSystem.stat(path.join(sharedHome, "config.toml")),
          ]);
          expect(configStat.ino).toBe(sharedConfigStat.ino);
        } else {
          expect(yield* fileSystem.readLink(configPath)).toBe(path.join(sharedHome, "config.toml"));
        }
        expect(logLinkResult._tag).toBe("Failure");
        expect(memoriesLinkResult._tag).toBe("Failure");
        expect(tmpLinkResult._tag).toBe("Failure");
      }),
    );

    it.effect("refreshes an F5-managed cross-volume copy on later materializations", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const sharedHome = yield* makeTempDir("t3code-codex-shared-");
        const shadowRoot = yield* makeTempDir("t3code-codex-shadow-root-");
        const shadowHome = path.join(shadowRoot, "shadow");
        const sharedConfig = path.join(sharedHome, "config.toml");
        const shadowConfig = path.join(shadowHome, "config.toml");
        yield* writeTextFile(sharedConfig, 'model = "first"\n');

        const layout = yield* resolveCodexHomeLayout(
          decodeCodexSettings({ homePath: sharedHome, shadowHomePath: shadowHome }),
        );
        const copyOptions = { platform: "win32", forceWindowsFileCopy: true } as const;

        yield* materializeCodexShadowHome(layout, copyOptions);
        expect(yield* fileSystem.readFileString(shadowConfig)).toContain("first");
        expect(
          yield* fileSystem.exists(path.join(shadowHome, CODEX_SHADOW_MANAGED_FILES_MANIFEST)),
        ).toBe(true);

        yield* fileSystem.writeFileString(sharedConfig, 'model = "second"\n');
        yield* materializeCodexShadowHome(layout, copyOptions);
        expect(yield* fileSystem.readFileString(shadowConfig)).toContain("second");
      }),
    );

    it.effect("relinks an owned Windows hard link when the shared file inode changes", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const sharedHome = yield* makeTempDir("t3code-codex-shared-");
        const shadowRoot = yield* makeTempDir("t3code-codex-shadow-root-");
        const shadowHome = path.join(shadowRoot, "shadow");
        const sharedConfig = path.join(sharedHome, "config.toml");
        const shadowConfig = path.join(shadowHome, "config.toml");
        yield* writeTextFile(sharedConfig, 'model = "first"\n');

        const layout = yield* resolveCodexHomeLayout(
          decodeCodexSettings({ homePath: sharedHome, shadowHomePath: shadowHome }),
        );
        const windowsOptions = { platform: "win32" } as const;
        yield* materializeCodexShadowHome(layout, windowsOptions);

        yield* fileSystem.remove(sharedConfig);
        yield* fileSystem.writeFileString(sharedConfig, 'model = "replacement"\n');
        yield* materializeCodexShadowHome(layout, windowsOptions);

        const [sharedStat, shadowStat] = yield* Effect.all([
          fileSystem.stat(sharedConfig),
          fileSystem.stat(shadowConfig),
        ]);
        expect(shadowStat.ino).toBe(sharedStat.ino);
        expect(yield* fileSystem.readFileString(shadowConfig)).toContain("replacement");
      }),
    );

    it.effect("rejects shadow homes that point at the shared home", () =>
      Effect.gen(function* () {
        const sharedHome = yield* makeTempDir("t3code-codex-shared-");
        const layout = yield* resolveCodexHomeLayout(
          decodeCodexSettings({
            homePath: sharedHome,
            shadowHomePath: sharedHome,
          }),
        );

        const error = yield* materializeCodexShadowHome(layout).pipe(Effect.flip);

        expect(error).toBeInstanceOf(CodexShadowHomeError);
      }),
    );

    it.effect("rejects shared entries that already exist in the shadow home as real files", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const sharedHome = yield* makeTempDir("t3code-codex-shared-");
        const shadowRoot = yield* makeTempDir("t3code-codex-shadow-root-");
        const shadowHome = path.join(shadowRoot, "shadow");
        yield* writeTextFile(path.join(sharedHome, "config.toml"), 'model = "gpt-5-codex"\n');
        yield* writeTextFile(path.join(shadowHome, "config.toml"), 'model = "local"\n');

        const layout = yield* resolveCodexHomeLayout(
          decodeCodexSettings({
            homePath: sharedHome,
            shadowHomePath: shadowHome,
          }),
        );

        const error = yield* materializeCodexShadowHome(layout).pipe(Effect.flip);

        expect(error.detail).toContain("already exists and is not an F5-managed link or copy");
      }),
    );
  });
});
