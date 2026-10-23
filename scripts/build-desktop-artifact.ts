#!/usr/bin/env node
import { DESKTOP_MAC_EXTEND_INFO } from "./lib/desktop-mac-info.ts";
import { DESKTOP_PROTOCOLS } from "./lib/desktop-protocols.ts";
import { withoutSigningCredentials } from "./lib/signing-environment.ts";

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync as requireReadLock } from "node:fs";
import { join } from "node:path";

import rootPackageJson from "../package.json" with { type: "json" };
import desktopPackageJson from "../apps/desktop/package.json" with { type: "json" };
import serverPackageJson from "../apps/server/package.json" with { type: "json" };

import { seedStagedLockfile, verifyStagedLockfile } from "./verify-staged-lockfile.ts";
import { RELEASE_UPDATE_REPOSITORY, verifyAppUpdateConfig } from "./lib/app-update-config.ts";
import { BRAND_ASSET_PATHS } from "./lib/brand-assets.ts";
import { stagedDesktopDependencies } from "./lib/desktop-stage.ts";

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Config, Data, Effect, FileSystem, Layer, Logger, Option, Path, Schema } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

const BuildPlatform = Schema.Literals(["mac", "linux", "win"]);
const BuildArch = Schema.Literals(["arm64", "x64", "universal"]);
export const DESKTOP_ASAR_UNPACK = ["node_modules/@ff-labs/fff-bin-*/**/*"] as const;

const RepoRoot = Effect.service(Path.Path).pipe(
  Effect.flatMap((path) => path.fromFileUrl(new URL("..", import.meta.url))),
);
const ProductionMacIconSource = Effect.zipWith(
  RepoRoot,
  Effect.service(Path.Path),
  (repoRoot, path) => path.join(repoRoot, BRAND_ASSET_PATHS.productionMacIconPng),
);
const ProductionLinuxIconSource = Effect.zipWith(
  RepoRoot,
  Effect.service(Path.Path),
  (repoRoot, path) => path.join(repoRoot, BRAND_ASSET_PATHS.productionLinuxIconPng),
);
const ProductionWindowsIconSource = Effect.zipWith(
  RepoRoot,
  Effect.service(Path.Path),
  (repoRoot, path) => path.join(repoRoot, BRAND_ASSET_PATHS.productionWindowsIconIco),
);
const encodeJsonString = Schema.encodeEffect(Schema.UnknownFromJsonString);

interface PlatformConfig {
  readonly cliFlag: "--mac" | "--linux" | "--win";
  readonly defaultTarget: string;
  readonly archChoices: ReadonlyArray<typeof BuildArch.Type>;
}

const PLATFORM_CONFIG: Record<typeof BuildPlatform.Type, PlatformConfig> = {
  mac: {
    cliFlag: "--mac",
    defaultTarget: "dmg",
    archChoices: ["arm64", "x64", "universal"],
  },
  linux: {
    cliFlag: "--linux",
    defaultTarget: "AppImage",
    archChoices: ["x64", "arm64"],
  },
  win: {
    cliFlag: "--win",
    defaultTarget: "nsis",
    archChoices: ["x64", "arm64"],
  },
};

interface BuildCliInput {
  readonly platform: Option.Option<typeof BuildPlatform.Type>;
  readonly target: Option.Option<string>;
  readonly arch: Option.Option<typeof BuildArch.Type>;
  readonly buildVersion: Option.Option<string>;
  readonly outputDir: Option.Option<string>;
  readonly skipBuild: Option.Option<boolean>;
  readonly keepStage: Option.Option<boolean>;
  readonly signed: Option.Option<boolean>;
  readonly verbose: Option.Option<boolean>;
}

function detectHostBuildPlatform(hostPlatform: string): typeof BuildPlatform.Type | undefined {
  if (hostPlatform === "darwin") return "mac";
  if (hostPlatform === "linux") return "linux";
  if (hostPlatform === "win32") return "win";
  return undefined;
}

function getDefaultArch(platform: typeof BuildPlatform.Type): typeof BuildArch.Type {
  const config = PLATFORM_CONFIG[platform];
  if (!config) {
    return "x64";
  }

  if (process.arch === "arm64" && config.archChoices.includes("arm64")) {
    return "arm64";
  }
  if (process.arch === "x64" && config.archChoices.includes("x64")) {
    return "x64";
  }

  return config.archChoices[0] ?? "x64";
}

class BuildScriptError extends Data.TaggedError("BuildScriptError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

function resolveGitCommitHash(repoRoot: string): string {
  const result = spawnSync("git", ["rev-parse", "--short=12", "HEAD"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    return "unknown";
  }
  const hash = result.stdout.trim();
  if (!/^[0-9a-f]{7,40}$/i.test(hash)) {
    return "unknown";
  }
  return hash.toLowerCase();
}

function resolvePythonForNodeGyp(): string | undefined {
  const configured = process.env.npm_config_python ?? process.env.PYTHON;
  if (configured && existsSync(configured)) {
    return configured;
  }

  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA;
    if (localAppData) {
      for (const version of ["Python313", "Python312", "Python311", "Python310"]) {
        const candidate = join(localAppData, "Programs", "Python", version, "python.exe");
        if (existsSync(candidate)) {
          return candidate;
        }
      }
    }
  }

  const probe = spawnSync("python", ["-c", "import sys;print(sys.executable)"], {
    encoding: "utf8",
  });
  if (probe.status !== 0) {
    return undefined;
  }

  const executable = probe.stdout.trim();
  if (!executable || !existsSync(executable)) {
    return undefined;
  }

  return executable;
}

interface ResolvedBuildOptions {
  readonly platform: typeof BuildPlatform.Type;
  readonly target: string;
  readonly arch: typeof BuildArch.Type;
  readonly version: string | undefined;
  readonly outputDir: string;
  readonly skipBuild: boolean;
  readonly keepStage: boolean;
  readonly signed: boolean;
  readonly verbose: boolean;
}

interface StagePackageJson {
  readonly name: string;
  readonly version: string;
  readonly buildVersion: string;
  readonly t3codeCommitHash: string;
  readonly private: true;
  readonly description: string;
  readonly author: string;
  readonly main: string;
  readonly build: Record<string, unknown>;
  readonly dependencies: Record<string, unknown>;
  readonly devDependencies: {
    readonly electron: string;
  };
  readonly overrides?: Record<string, string>;
}

const AzureTrustedSigningOptionsConfig = Config.all({
  publisherName: Config.string("AZURE_TRUSTED_SIGNING_PUBLISHER_NAME"),
  endpoint: Config.string("AZURE_TRUSTED_SIGNING_ENDPOINT"),
  certificateProfileName: Config.string("AZURE_TRUSTED_SIGNING_CERTIFICATE_PROFILE_NAME"),
  codeSigningAccountName: Config.string("AZURE_TRUSTED_SIGNING_ACCOUNT_NAME"),
  fileDigest: Config.string("AZURE_TRUSTED_SIGNING_FILE_DIGEST").pipe(Config.withDefault("SHA256")),
  timestampDigest: Config.string("AZURE_TRUSTED_SIGNING_TIMESTAMP_DIGEST").pipe(
    Config.withDefault("SHA256"),
  ),
  timestampRfc3161: Config.string("AZURE_TRUSTED_SIGNING_TIMESTAMP_RFC3161").pipe(
    Config.withDefault("http://timestamp.acs.microsoft.com"),
  ),
});

const BuildEnvConfig = Config.all({
  platform: Config.schema(BuildPlatform, "T3CODE_DESKTOP_PLATFORM").pipe(Config.option),
  target: Config.string("T3CODE_DESKTOP_TARGET").pipe(Config.option),
  arch: Config.schema(BuildArch, "T3CODE_DESKTOP_ARCH").pipe(Config.option),
  version: Config.string("T3CODE_DESKTOP_VERSION").pipe(Config.option),
  outputDir: Config.string("T3CODE_DESKTOP_OUTPUT_DIR").pipe(Config.option),
  skipBuild: Config.boolean("T3CODE_DESKTOP_SKIP_BUILD").pipe(Config.withDefault(false)),
  keepStage: Config.boolean("T3CODE_DESKTOP_KEEP_STAGE").pipe(Config.withDefault(false)),
  signed: Config.boolean("T3CODE_DESKTOP_SIGNED").pipe(Config.withDefault(false)),
  verbose: Config.boolean("T3CODE_DESKTOP_VERBOSE").pipe(Config.withDefault(false)),
});

const resolveBooleanFlag = (flag: Option.Option<boolean>, envValue: boolean) =>
  Option.getOrElse(Option.filter(flag, Boolean), () => envValue);
const mergeOptions = <A>(a: Option.Option<A>, b: Option.Option<A>, defaultValue: A) =>
  Option.getOrElse(a, () => Option.getOrElse(b, () => defaultValue));

const resolveBuildOptions = Effect.fn("resolveBuildOptions")(function* (input: BuildCliInput) {
  const path = yield* Path.Path;
  const repoRoot = yield* RepoRoot;
  const env = yield* BuildEnvConfig.asEffect();

  const platform = mergeOptions(
    input.platform,
    env.platform,
    detectHostBuildPlatform(process.platform),
  );

  if (!platform) {
    return yield* new BuildScriptError({
      message: `Unsupported host platform '${process.platform}'.`,
    });
  }

  const target = mergeOptions(input.target, env.target, PLATFORM_CONFIG[platform].defaultTarget);
  const arch = mergeOptions(input.arch, env.arch, getDefaultArch(platform));
  const version = mergeOptions(input.buildVersion, env.version, undefined);
  const outputDir = path.resolve(repoRoot, mergeOptions(input.outputDir, env.outputDir, "release"));

  const skipBuild = resolveBooleanFlag(input.skipBuild, env.skipBuild);
  const keepStage = resolveBooleanFlag(input.keepStage, env.keepStage);
  const signed = resolveBooleanFlag(input.signed, env.signed);
  const verbose = resolveBooleanFlag(input.verbose, env.verbose);

  return {
    platform,
    target,
    arch,
    version,
    outputDir,
    skipBuild,
    keepStage,
    signed,
    verbose,
  } satisfies ResolvedBuildOptions;
});

const commandOutputOptions = (verbose: boolean) =>
  ({
    stdout: verbose ? "inherit" : "ignore",
    stderr: "inherit",
  }) as const;

const runCommand = Effect.fn("runCommand")(function* (command: ChildProcess.Command) {
  const commandSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const child = yield* commandSpawner.spawn(command);
  const exitCode = yield* child.exitCode;

  if (exitCode !== 0) {
    return yield* new BuildScriptError({
      message: `Command exited with non-zero exit code (${exitCode})`,
    });
  }
});

function generateMacIconSet(
  sourcePng: string,
  targetIcns: string,
  tmpRoot: string,
  path: Path.Path,
  verbose: boolean,
) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const iconsetDir = path.join(tmpRoot, "icon.iconset");
    yield* fs.makeDirectory(iconsetDir, { recursive: true });

    const iconSizes = [16, 32, 128, 256, 512] as const;
    for (const size of iconSizes) {
      yield* runCommand(
        ChildProcess.make({
          ...commandOutputOptions(verbose),
        })`sips -z ${size} ${size} ${sourcePng} --out ${path.join(iconsetDir, `icon_${size}x${size}.png`)}`,
      );

      const retinaSize = size * 2;
      yield* runCommand(
        ChildProcess.make({
          ...commandOutputOptions(verbose),
        })`sips -z ${retinaSize} ${retinaSize} ${sourcePng} --out ${path.join(iconsetDir, `icon_${size}x${size}@2x.png`)}`,
      );
    }

    yield* runCommand(
      ChildProcess.make({
        ...commandOutputOptions(verbose),
      })`iconutil -c icns ${iconsetDir} -o ${targetIcns}`,
    );
  });
}

function stageMacIcons(stageResourcesDir: string, verbose: boolean) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const iconSource = yield* ProductionMacIconSource;
    if (!(yield* fs.exists(iconSource))) {
      return yield* new BuildScriptError({
        message: `Production icon source is missing at ${iconSource}`,
      });
    }

    const tmpRoot = yield* fs.makeTempDirectoryScoped({
      prefix: "t3code-icon-build-",
    });

    const iconPngPath = path.join(stageResourcesDir, "icon.png");
    const iconIcnsPath = path.join(stageResourcesDir, "icon.icns");

    yield* runCommand(
      ChildProcess.make({
        ...commandOutputOptions(verbose),
      })`sips -z 512 512 ${iconSource} --out ${iconPngPath}`,
    );

    yield* generateMacIconSet(iconSource, iconIcnsPath, tmpRoot, path, verbose);
  });
}

function stageLinuxIcons(stageResourcesDir: string) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const iconSource = yield* ProductionLinuxIconSource;
    if (!(yield* fs.exists(iconSource))) {
      return yield* new BuildScriptError({
        message: `Production icon source is missing at ${iconSource}`,
      });
    }

    const iconPath = path.join(stageResourcesDir, "icon.png");
    yield* fs.copyFile(iconSource, iconPath);
  });
}

function stageWindowsIcons(stageResourcesDir: string) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const iconSource = yield* ProductionWindowsIconSource;
    if (!(yield* fs.exists(iconSource))) {
      return yield* new BuildScriptError({
        message: `Production Windows icon source is missing at ${iconSource}`,
      });
    }

    const iconPath = path.join(stageResourcesDir, "icon.ico");
    yield* fs.copyFile(iconSource, iconPath);
  });
}

function validateBundledClientAssets(clientDir: string) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const indexPath = path.join(clientDir, "index.html");
    const indexHtml = yield* fs.readFileString(indexPath);
    const refs = [...indexHtml.matchAll(/\b(?:src|href)=["']([^"']+)["']/g)]
      .map((match) => match[1])
      .filter((value): value is string => value !== undefined);
    const missing: string[] = [];

    for (const ref of refs) {
      const normalizedRef = ref.split("#")[0]?.split("?")[0] ?? "";
      if (!normalizedRef) continue;
      if (normalizedRef.startsWith("http://") || normalizedRef.startsWith("https://")) continue;
      if (normalizedRef.startsWith("data:") || normalizedRef.startsWith("mailto:")) continue;

      const ext = path.extname(normalizedRef);
      if (!ext) continue;

      const relativePath = normalizedRef.replace(/^\/+/, "");
      const assetPath = path.join(clientDir, relativePath);
      if (!(yield* fs.exists(assetPath))) {
        missing.push(normalizedRef);
      }
    }

    if (missing.length > 0) {
      const preview = missing.slice(0, 6).join(", ");
      const suffix = missing.length > 6 ? ` (+${missing.length - 6} more)` : "";
      return yield* new BuildScriptError({
        message: `Bundled client references missing files in ${indexPath}: ${preview}${suffix}. Rebuild web/server artifacts.`,
      });
    }
  });
}

function resolveGitHubPublishConfig(release: boolean):
  | {
      readonly provider: "github";
      readonly owner: string;
      readonly repo: string;
      readonly releaseType: "release";
      readonly channel: string;
    }
  | undefined {
  // Versioned builds always bake the production feed; the override only serves local builds.
  const rawRepo = release
    ? RELEASE_UPDATE_REPOSITORY
    : process.env.T3CODE_DESKTOP_UPDATE_REPOSITORY?.trim() ||
      process.env.GITHUB_REPOSITORY?.trim() ||
      "";
  if (!rawRepo) return undefined;

  const [owner, repo, ...rest] = rawRepo.split("/");
  if (!owner || !repo || rest.length > 0) return undefined;

  return {
    provider: "github",
    owner,
    repo,
    releaseType: "release",
    channel: process.env.T3CODE_DESKTOP_UPDATE_CHANNEL || "latest",
  };
}

const createBuildConfig = Effect.fn("createBuildConfig")(function* (
  platform: typeof BuildPlatform.Type,
  target: string,
  productName: string,
  signed: boolean,
  release: boolean,
) {
  const repositoryOverride = process.env.T3CODE_DESKTOP_UPDATE_REPOSITORY?.trim();
  if (release && repositoryOverride && repositoryOverride !== RELEASE_UPDATE_REPOSITORY) {
    return yield* new BuildScriptError({
      message: `Versioned builds use the ${RELEASE_UPDATE_REPOSITORY} update feed; unset T3CODE_DESKTOP_UPDATE_REPOSITORY (${repositoryOverride}).`,
    });
  }
  const buildConfig: Record<string, unknown> = {
    appId: "io.github.lopesfelipe.f5",
    electronFuses: {
      runAsNode: true, // Required by the sandboxed backend until it has a dedicated executable.
      enableNodeOptionsEnvironmentVariable: false,
      enableNodeCliInspectArguments: false,
      enableEmbeddedAsarIntegrityValidation: platform !== "linux",
      onlyLoadAppFromAsar: true,
    },
    productName,
    protocols: DESKTOP_PROTOCOLS,
    artifactName: "F5-${version}-${arch}.${ext}",
    asarUnpack: DESKTOP_ASAR_UNPACK,
    ...(platform !== "linux"
      ? {
          extraResources: [{ from: "apps/desktop/native-bin", to: "native" }],
          ...(signed ? { afterSign: "verify-computer-helper.cjs" } : {}),
        }
      : {}),
    directories: {
      buildResources: "apps/desktop/resources",
    },
  };
  const publishConfig = resolveGitHubPublishConfig(release);
  if (publishConfig) {
    buildConfig.publish = [publishConfig];
  } else if (release) {
    return yield* new BuildScriptError({
      message: "Versioned builds require a resolved update feed.",
    });
  }

  if (platform === "mac") {
    if (
      signed &&
      [
        "CSC_LINK",
        "CSC_KEY_PASSWORD",
        "APPLE_API_KEY",
        "APPLE_API_KEY_ID",
        "APPLE_API_ISSUER",
      ].some((key) => !process.env[key])
    ) {
      return yield* new BuildScriptError({
        message: "Signed macOS builds require all Apple signing and notarization credentials.",
      });
    }
    buildConfig.mac = {
      target: target === "dmg" ? [target, "zip"] : [target],
      icon: "icon.icns",
      category: "public.app-category.developer-tools",
      extendInfo: DESKTOP_MAC_EXTEND_INFO,
      ...(signed
        ? {
            hardenedRuntime: true,
            gatekeeperAssess: false,
            notarize: true,
            entitlements: "apps/desktop/resources/entitlements.mac.plist",
            entitlementsInherit: "apps/desktop/resources/entitlements.electron-inherit.plist",
            sign: join(import.meta.dirname, "sign-mac.cjs"),
          }
        : {}),
      binaries: ["Contents/Resources/native/f5-computer-helper"],
    };
  }

  if (platform === "linux") {
    buildConfig.linux = {
      target: [target],
      icon: "icon.png",
      category: "Development",
    };
  }

  if (platform === "win") {
    const winConfig: Record<string, unknown> = {
      target: [target],
      icon: "icon.ico",
    };
    if (signed) {
      winConfig.azureSignOptions = yield* AzureTrustedSigningOptionsConfig;
    } else {
      // `signAndEditExecutable: false` would also skip rcedit and drop the icon and
      // version metadata. Without a publisherName, updates skip signature checks;
      // the first signed release embeds one for all later updates.
      winConfig.signExecutable = false;
      winConfig.verifyUpdateCodeSignature = false;
    }
    buildConfig.win = winConfig;
    buildConfig.nsis = {
      oneClick: true,
      perMachine: false,
      allowElevation: false,
      createStartMenuShortcut: true,
      createDesktopShortcut: false,
    };
  }

  return buildConfig;
});

const assertPlatformBuildResources = Effect.fn("assertPlatformBuildResources")(function* (
  platform: typeof BuildPlatform.Type,
  stageResourcesDir: string,
  verbose: boolean,
) {
  if (platform === "mac") {
    yield* stageMacIcons(stageResourcesDir, verbose);
    return;
  }

  if (platform === "linux") {
    yield* stageLinuxIcons(stageResourcesDir);
    return;
  }

  if (platform === "win") {
    yield* stageWindowsIcons(stageResourcesDir);
  }
});

const buildDesktopArtifact = Effect.fn("buildDesktopArtifact")(function* (
  options: ResolvedBuildOptions,
) {
  const repoRoot = yield* RepoRoot;
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;

  const platformConfig = PLATFORM_CONFIG[options.platform];
  if (!platformConfig) {
    return yield* new BuildScriptError({
      message: `Unsupported platform '${options.platform}'.`,
    });
  }

  const electronVersion = desktopPackageJson.dependencies.electron;

  const stagedDependencies = yield* Effect.try({
    try: () =>
      stagedDesktopDependencies({
        platform: options.platform,
        arch: options.arch,
        serverDependencies: serverPackageJson.dependencies ?? {},
        desktopDependencies: desktopPackageJson.dependencies,
        catalog: rootPackageJson.workspaces.catalog,
      }),
    catch: (cause) =>
      new BuildScriptError({
        message: `Could not resolve staged desktop dependencies: ${String(cause)}`,
        cause,
      }),
  });

  const appVersion = options.version ?? serverPackageJson.version;
  const commitHash = resolveGitCommitHash(repoRoot);
  const mkdir = options.keepStage ? fs.makeTempDirectory : fs.makeTempDirectoryScoped;
  const stageRoot = yield* mkdir({
    prefix: `t3code-desktop-${options.platform}-stage-`,
  });

  const stageAppDir = path.join(stageRoot, "app");
  const stageResourcesDir = path.join(stageAppDir, "apps/desktop/resources");
  const distDirs = {
    desktopDist: path.join(repoRoot, "apps/desktop/dist-electron"),
    desktopResources: path.join(repoRoot, "apps/desktop/resources"),
    serverDist: path.join(repoRoot, "apps/server/dist"),
  };
  const bundledClientEntry = path.join(distDirs.serverDist, "client/index.html");

  if (!options.skipBuild) {
    yield* Effect.log("[desktop-artifact] Building desktop/server/web artifacts...");
    yield* runCommand(
      ChildProcess.make({
        cwd: repoRoot,
        env: withoutSigningCredentials(process.env),
        extendEnv: false,
        ...commandOutputOptions(options.verbose),
        // Windows needs shell mode to resolve .cmd shims (e.g. bun.cmd).
        shell: process.platform === "win32",
      })`bun run build:desktop`,
    );
  }

  for (const [label, dir] of Object.entries(distDirs)) {
    if (!(yield* fs.exists(dir))) {
      return yield* new BuildScriptError({
        message: `Missing ${label} at ${dir}. Run 'bun run build:desktop' first.`,
      });
    }
  }

  if (!(yield* fs.exists(bundledClientEntry))) {
    return yield* new BuildScriptError({
      message: `Missing bundled server client at ${bundledClientEntry}. Run 'bun run build:desktop' first.`,
    });
  }

  yield* validateBundledClientAssets(path.dirname(bundledClientEntry));

  yield* fs.makeDirectory(path.join(stageAppDir, "apps/desktop"), { recursive: true });
  yield* fs.makeDirectory(path.join(stageAppDir, "apps/server"), { recursive: true });

  yield* Effect.log("[desktop-artifact] Staging release app...");
  yield* fs.copy(distDirs.desktopDist, path.join(stageAppDir, "apps/desktop/dist-electron"));
  yield* fs.copy(distDirs.desktopResources, stageResourcesDir);
  yield* fs.copy(distDirs.serverDist, path.join(stageAppDir, "apps/server/dist"));
  if (options.platform !== "linux") {
    yield* runCommand(
      ChildProcess.make(
        process.execPath,
        [
          path.join(repoRoot, "scripts/build-computer-helper.ts"),
          "--platform",
          options.platform,
          "--arch",
          options.arch,
          "--required",
        ],
        { cwd: repoRoot, ...commandOutputOptions(options.verbose) },
      ),
    );
    const nativeDir = path.join(
      repoRoot,
      "apps/desktop/dist-native",
      `${options.platform}-${options.arch}`,
    );
    const binary = path.join(
      nativeDir,
      options.platform === "win" ? "f5-computer-helper.exe" : "f5-computer-helper",
    );
    if (!(yield* fs.exists(binary)))
      return yield* new BuildScriptError({ message: `Missing computer helper: ${binary}` });
    yield* fs.copy(nativeDir, path.join(stageAppDir, "apps/desktop/native-bin"));
    yield* fs.copyFile(
      path.join(repoRoot, "scripts/verify-computer-helper.cjs"),
      path.join(stageAppDir, "verify-computer-helper.cjs"),
    );
  }

  yield* assertPlatformBuildResources(options.platform, stageResourcesDir, options.verbose);

  // electron-builder is filtering out stageResourcesDir directory in the AppImage for production
  yield* fs.copy(stageResourcesDir, path.join(stageAppDir, "apps/desktop/prod-resources"));

  const stagePackageJson: StagePackageJson = {
    name: "f5-desktop",
    version: appVersion,
    buildVersion: appVersion,
    t3codeCommitHash: commitHash,
    private: true,
    description: "F5 desktop app",
    author: "Felipe Lopes",
    main: "apps/desktop/dist-electron/boot.js",
    build: yield* createBuildConfig(
      options.platform,
      options.target,
      desktopPackageJson.productName ?? "F5",
      options.signed,
      options.version !== undefined,
    ),
    dependencies: stagedDependencies,
    devDependencies: {
      electron: electronVersion,
    },
    ...(rootPackageJson.overrides ? { overrides: rootPackageJson.overrides } : {}),
  };

  const stagePackageJsonString = yield* encodeJsonString(stagePackageJson);
  yield* fs.writeFileString(path.join(stageAppDir, "package.json"), `${stagePackageJsonString}\n`);

  const stagedBun = (args: TemplateStringsArray) =>
    runCommand(
      ChildProcess.make({
        cwd: stageAppDir,
        env: withoutSigningCredentials(process.env),
        extendEnv: false,
        ...commandOutputOptions(options.verbose),
        // Windows needs shell mode to resolve .cmd shims (e.g. bun.cmd).
        shell: process.platform === "win32",
      })(args),
    );
  // `bun install --production` never saves a lockfile, so resolve one first and
  // audit it before anything is installed or any install script runs. Seeding the
  // stage with the root lock keeps every root-locked version, including nested
  // duplicates, instead of re-resolving the manifest's ranges against the registry.
  const rootLock = requireReadLock(path.join(repoRoot, "bun.lock"), "utf8");
  yield* fs.writeFileString(
    path.join(stageAppDir, "bun.lock"),
    seedStagedLockfile(rootLock, stagePackageJson),
  );
  yield* Effect.log("[desktop-artifact] Resolving staged dependencies...");
  yield* stagedBun`bun install --lockfile-only --ignore-scripts`;

  yield* Effect.try({
    try: () =>
      verifyStagedLockfile(rootLock, requireReadLock(path.join(stageAppDir, "bun.lock"), "utf8")),
    catch: (error) =>
      new BuildScriptError({ message: `Staged dependency audit failed: ${String(error)}` }),
  });
  yield* Effect.log("[desktop-artifact] Installing staged production dependencies...");
  yield* stagedBun`bun install --production --frozen-lockfile`;
  yield* fs.makeDirectory(options.outputDir, { recursive: true });
  yield* fs.copyFile(
    path.join(stageAppDir, "bun.lock"),
    path.join(options.outputDir, `staged-${options.platform}-${options.arch}.lock`),
  );

  const buildEnv: NodeJS.ProcessEnv = {
    ...process.env,
  };
  for (const [key, value] of Object.entries(buildEnv)) {
    if (value === "") {
      delete buildEnv[key];
    }
  }
  if (!options.signed) {
    buildEnv.CSC_IDENTITY_AUTO_DISCOVERY = "false";
    delete buildEnv.CSC_LINK;
    delete buildEnv.CSC_KEY_PASSWORD;
    delete buildEnv.APPLE_API_KEY;
    delete buildEnv.APPLE_API_KEY_ID;
    delete buildEnv.APPLE_API_ISSUER;
    // A stray Windows certificate would otherwise sign and embed a publisherName.
    delete buildEnv.WIN_CSC_LINK;
    delete buildEnv.WIN_CSC_KEY_PASSWORD;
  }

  if (process.platform === "win32") {
    const python = resolvePythonForNodeGyp();
    if (python) {
      buildEnv.PYTHON = python;
      buildEnv.npm_config_python = python;
    }
    // Let node-gyp pick the newest supported Visual Studio: pinning a year rejects
    // every other install, and windows-latest now ships only VS 2026.
  }

  yield* Effect.log(
    `[desktop-artifact] Building ${options.platform}/${options.target} (arch=${options.arch}, version=${appVersion})...`,
  );
  // Run the pinned package's own entry point with this Node instead of a
  // node_modules/.bin shim: bun creates no .cmd shims on Windows, and this
  // avoids shell mode on every platform.
  const electronBuilderPackage = path.join(repoRoot, "node_modules", "electron-builder");
  const electronBuilderCli = path.join(electronBuilderPackage, "cli.js");
  const installedElectronBuilder = yield* fs
    .readFileString(path.join(electronBuilderPackage, "package.json"))
    .pipe(
      Effect.map((text) => (JSON.parse(text) as { version?: string }).version),
      Effect.catch(() => Effect.succeed(undefined)),
    );
  if (
    installedElectronBuilder !== rootPackageJson.devDependencies["electron-builder"] ||
    !(yield* fs.exists(electronBuilderCli))
  ) {
    return yield* new BuildScriptError({
      message: `Pinned electron-builder ${rootPackageJson.devDependencies["electron-builder"]} was not found at ${electronBuilderPackage} (found ${installedElectronBuilder ?? "none"}). Run bun install first.`,
    });
  }
  yield* runCommand(
    ChildProcess.make(
      process.execPath,
      [electronBuilderCli, platformConfig.cliFlag, `--${options.arch}`, "--publish", "never"],
      {
        cwd: stageAppDir,
        env: buildEnv,
        // electron-builder reports its errors on stdout, so never hide it.
        stdout: "inherit",
        stderr: "inherit",
      },
    ),
  );

  const stageDistDir = path.join(stageAppDir, "dist");
  if (!(yield* fs.exists(stageDistDir))) {
    return yield* new BuildScriptError({
      message: `Build completed but dist directory was not found at ${stageDistDir}`,
    });
  }

  if (options.platform === "win" && options.version !== undefined) {
    const unpacked = options.arch === "x64" ? "win-unpacked" : `win-${options.arch}-unpacked`;
    const appUpdatePath = path.join(stageDistDir, unpacked, "resources", "app-update.yml");
    const appUpdate = yield* fs.readFileString(appUpdatePath).pipe(
      Effect.mapError(
        (cause) =>
          new BuildScriptError({
            message: `Packaged update feed missing at ${appUpdatePath}`,
            cause,
          }),
      ),
    );
    yield* Effect.try({
      try: () =>
        verifyAppUpdateConfig(appUpdate, {
          channel: process.env.T3CODE_DESKTOP_UPDATE_CHANNEL || "latest",
          publisherName: options.signed
            ? process.env.AZURE_TRUSTED_SIGNING_PUBLISHER_NAME
            : undefined,
        }),
      catch: (cause) =>
        new BuildScriptError({
          message: `Packaged update feed is invalid: ${String(cause)}`,
          cause,
        }),
    });
  }

  const stageEntries = yield* fs.readDirectory(stageDistDir);
  yield* fs.makeDirectory(options.outputDir, { recursive: true });

  const copiedArtifacts: string[] = [];
  for (const entry of stageEntries) {
    const from = path.join(stageDistDir, entry);
    const stat = yield* fs.stat(from).pipe(Effect.catch(() => Effect.succeed(null)));
    if (!stat || stat.type !== "File") continue;

    const to = path.join(options.outputDir, entry);
    yield* fs.copyFile(from, to);
    copiedArtifacts.push(to);
  }

  if (copiedArtifacts.length === 0) {
    return yield* new BuildScriptError({
      message: `Build completed but no files were produced in ${stageDistDir}`,
    });
  }

  yield* Effect.log("[desktop-artifact] Done. Artifacts:").pipe(
    Effect.annotateLogs({ artifacts: copiedArtifacts }),
  );
});

const buildDesktopArtifactCli = Command.make("build-desktop-artifact", {
  platform: Flag.choice("platform", BuildPlatform.literals).pipe(
    Flag.withDescription("Build platform (env: T3CODE_DESKTOP_PLATFORM)."),
    Flag.optional,
  ),
  target: Flag.string("target").pipe(
    Flag.withDescription(
      "Artifact target, for example dmg/AppImage/nsis (env: T3CODE_DESKTOP_TARGET).",
    ),
    Flag.optional,
  ),
  arch: Flag.choice("arch", BuildArch.literals).pipe(
    Flag.withDescription("Build arch, for example arm64/x64/universal (env: T3CODE_DESKTOP_ARCH)."),
    Flag.optional,
  ),
  buildVersion: Flag.string("build-version").pipe(
    Flag.withDescription("Artifact version metadata (env: T3CODE_DESKTOP_VERSION)."),
    Flag.optional,
  ),
  outputDir: Flag.string("output-dir").pipe(
    Flag.withDescription("Output directory for artifacts (env: T3CODE_DESKTOP_OUTPUT_DIR)."),
    Flag.optional,
  ),
  skipBuild: Flag.boolean("skip-build").pipe(
    Flag.withDescription(
      "Skip `bun run build:desktop` and use existing dist artifacts (env: T3CODE_DESKTOP_SKIP_BUILD).",
    ),
    Flag.optional,
  ),
  keepStage: Flag.boolean("keep-stage").pipe(
    Flag.withDescription("Keep temporary staging files (env: T3CODE_DESKTOP_KEEP_STAGE)."),
    Flag.optional,
  ),
  signed: Flag.boolean("signed").pipe(
    Flag.withDescription(
      "Enable signing/notarization discovery; Windows uses Azure Trusted Signing (env: T3CODE_DESKTOP_SIGNED).",
    ),
    Flag.optional,
  ),
  verbose: Flag.boolean("verbose").pipe(
    Flag.withDescription("Stream subprocess stdout (env: T3CODE_DESKTOP_VERBOSE)."),
    Flag.optional,
  ),
}).pipe(
  Command.withDescription("Build a desktop artifact for T3 Code."),
  Command.withHandler((input) => Effect.flatMap(resolveBuildOptions(input), buildDesktopArtifact)),
);

const cliRuntimeLayer = Layer.mergeAll(Logger.layer([Logger.consolePretty()]), NodeServices.layer);

Command.run(buildDesktopArtifactCli, { version: "0.0.0" }).pipe(
  Effect.scoped,
  Effect.provide(cliRuntimeLayer),
  NodeRuntime.runMain,
);
