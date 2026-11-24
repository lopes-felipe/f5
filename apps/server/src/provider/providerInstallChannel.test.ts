import {
  mkdtempSync,
  symlinkSync,
  unlinkSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import * as Path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ProviderDriverKind } from "@t3tools/contracts";
import {
  buildProviderUpdateCommand,
  canRunInApp,
  filterProviderUpdateEnvironment,
  detectProviderInstallTarget,
  makeInstanceInstallTargetResolver,
  type DetectProviderInstallTargetInput,
  type InstallTargetDependencies,
} from "./providerInstallChannel.ts";

async function fixture(
  realPath: string,
  options: {
    driver?: string;
    binaryPath?: string;
    files?: Record<string, string>;
    platform?: NodeJS.Platform;
    serverUrl?: string;
    environment?: NodeJS.ProcessEnv;
  } = {},
) {
  const files = options.files ?? {};
  const input: DetectProviderInstallTargetInput = {
    driver: ProviderDriverKind.make(options.driver ?? "codex"),
    binaryPath: options.binaryPath ?? "/bin/cli",
    resolutionEnvironment: { PATH: "/probe/bin", HOME: "/isolated" },
    updateEnvironment: options.environment ?? { HOME: "/isolated" },
    serverUrl: options.serverUrl,
  };
  const dependencies: Partial<InstallTargetDependencies> = {
    resolveExecutable: async () => options.binaryPath ?? "/bin/cli",
    realpath: () => realPath,
    resolveInvocation: async () => ({ file: "C:\\node.exe", args: [realPath], kind: "npmShim" }),
    exists: (file) => Object.hasOwn(files, file),
    canWrite: () => true,
    readFile: (file) => {
      if (!(file in files)) throw new Error("missing");
      return files[file]!;
    },
    homeDir: "/home/test",
    platform: options.platform ?? "linux",
    bundledExecutable: () => "/f5/sdk/claude",
    bundledCodexExecutable: () => "/f5/codex/bin/codex",
  };
  return { input, dependencies, target: await detectProviderInstallTarget(input, dependencies) };
}
const npmFiles = {
  "/nvm/v24/lib/node_modules/@openai/codex/package.json": '{"name":"@openai/codex"}',
  "/nvm/v24/bin/npm": "",
  "/nvm/v24/bin/node": "",
};

describe("provider installation ownership", () => {
  it.each([
    ["a latest shim", "/home/test/.local/share/mise/shims/grok", "latest", true, true, false],
    ["a latest symlink", "/mise-data/installs/grok/latest/bin/grok", "latest", true, true, false],
    ["a pinned shim", "/home/test/.local/share/mise/shims/grok", "2.0", true, false, false],
    ["a fixed version path", "/mise-data/installs/grok/2.0/bin/grok", "latest", true, false, false],
    [
      "an inactive install",
      "/mise-data/installs/grok/latest/bin/grok",
      "latest",
      false,
      false,
      false,
    ],
    ["a mise exec wrapper", "/some/bin/grok", "latest", true, false, true],
  ])(
    "uses mise ownership for %s",
    async (_, executable, requestedVersion, active, automatic, wrapper) => {
      const binary = "/mise-data/installs/grok/2.0/bin/grok";
      const mise = "/usr/local/bin/mise";
      const runProcess = vi.fn<InstallTargetDependencies["runProcess"]>(async (_command, args) => ({
        stdout:
          args[0] === "which"
            ? binary
            : JSON.stringify({
                grok: [
                  {
                    active,
                    requested_version: requestedVersion,
                    install_path: "/mise-data/installs/grok/2.0",
                  },
                ],
              }),
        stderr: "",
        code: 0,
        timedOut: false,
        signal: null,
      }));
      const target = (await detectProviderInstallTarget(
        {
          driver: ProviderDriverKind.make("grok"),
          resolutionEnvironment: { PATH: "/usr/local/bin" },
          updateEnvironment: {
            PATH: "/usr/local/bin",
            MISE_DATA_DIR: "/mise-data",
            GROK_API_KEY: "secret",
          },
        },
        {
          platform: "linux",
          resolveExecutable: async (command) => (command === "mise" ? mise : executable),
          realpath: (file) =>
            file === executable ? (file.includes("/shims/") ? mise : binary) : file,
          runProcess,
          isMiseWrapper: () => wrapper,
        },
      ))!;
      expect(target.channel).toBe("mise");
      expect(canRunInApp(target, "linux", { isDefault: true })).toBe(automatic);
      if (!automatic) {
        expect(target.latestSource).toBeNull();
        expect(buildProviderUpdateCommand(target, "linux", "3.0.0")).toBeNull();
        return;
      }
      expect(runProcess).toHaveBeenCalledWith(
        mise,
        ["which", "grok"],
        expect.objectContaining({
          env: { PATH: "/usr/local/bin", MISE_DATA_DIR: "/mise-data", MISE_OFFLINE: "1" },
        }),
      );
      expect(target.latestSource).toEqual({ kind: "mise", executable: mise, tool: "grok" });
      expect(buildProviderUpdateCommand(target, "linux", "3.0.0")).toMatchObject({
        executable: mise,
        channel: "mise",
        args: ["upgrade", "grok"],
      });
    },
  );

  it.each(["opencode", "grok"])(
    "keeps mise in charge of %s when upgrade eligibility is unverified",
    async (tool) => {
      const mise = "/usr/local/bin/mise";
      const executable = "/custom/tools/" + tool + "/latest/bin/" + tool;
      const binary = executable.replace("/latest/", "/1.0.0/");
      const target = await detectProviderInstallTarget(
        {
          driver: ProviderDriverKind.make(tool),
          resolutionEnvironment: {},
          updateEnvironment: {},
        },
        {
          platform: "linux",
          resolveExecutable: async (command) => (command === "mise" ? mise : executable),
          realpath: (file) => (file === executable ? binary : file),
          isMiseWrapper: () => false,
          runProcess: async (_command, args) => {
            if (tool === "grok" && args[0] === "ls") throw new Error("probe failed");
            return {
              stdout:
                args[0] === "which"
                  ? binary
                  : JSON.stringify([
                      {
                        install_path: "/custom/tools/opencode/1.0.0",
                        active: true,
                        requested_version: "latest",
                      },
                    ]),
              stderr: "",
              code: 0,
              timedOut: false,
              signal: null,
            };
          },
        },
      );
      expect(target).toMatchObject({
        channel: "mise",
        latestSource: null,
        blockedReason: "unsupported_source",
      });
      if (tool === "opencode") expect(target?.guidance).toContain("1.x");
      expect(buildProviderUpdateCommand(target!, "linux", "2.0.0")).toBeNull();
    },
  );

  it("does not group bundled Codex and Claude as one shared installation", async () => {
    const codex = (await fixture("", { driver: "codex", binaryPath: "codex" })).target!;
    const claude = (await fixture("", { driver: "claudeAgent", binaryPath: "claude" })).target!;
    expect(codex.installKey).not.toBe(claude.installKey);
  });
  it.each(["", "codex", " codex "])(
    "classifies default Codex %s as bundled without probing PATH",
    async (binaryPath) => {
      const { input, dependencies } = await fixture("/other/codex", { binaryPath });
      const target = await detectProviderInstallTarget(input, {
        ...dependencies,
        resolveExecutable: async () => {
          throw new Error("must not resolve PATH");
        },
      });
      expect(target?.channel).toBe("bundled");
      expect(target?.executablePath).toBe("/f5/codex/bin/codex");
      expect(buildProviderUpdateCommand(target!, "linux", "1.0.0")).toBeNull();
    },
  );
  it("uses one canonical native-install key for different Claude aliases", async () => {
    const first = (
      await fixture("/home/test/.local/share/claude/versions/2.0.0", {
        driver: "claudeAgent",
        binaryPath: "/bin/claude-alias",
      })
    ).target!;
    const second = (
      await fixture("/home/test/.local/share/claude/versions/2.1.0", {
        driver: "claudeAgent",
        binaryPath: "/other/claude",
      })
    ).target!;
    expect(first.installKey).toBe(second.installKey);
    expect(first.executablePath).not.toBe(second.executablePath);
    expect(buildProviderUpdateCommand(first, "linux")?.executable).toBe("/bin/claude-alias");
  });
  it("keeps non-writable npm prefixes copy-only", async () => {
    const { input, dependencies } = await fixture(
      "/nvm/v24/lib/node_modules/@openai/codex/bin/codex.js",
      { files: npmFiles },
    );
    const target = (await detectProviderInstallTarget(input, {
      ...dependencies,
      canWrite: () => false,
    }))!;
    expect(target.channel).toBe("npm");
    expect(target.blockedReason).toBe("permissions");
    expect(canRunInApp(target, "linux", { isDefault: true })).toBe(false);
    expect(buildProviderUpdateCommand(target, "linux", "1.1.0")).not.toBeNull();
  });
  it("keeps third-party cask references qualified for checking and upgrading", async () => {
    const { target } = await fixture("/opt/homebrew/Caskroom/codex/1.0/codex", {
      files: {
        "/opt/homebrew/bin/brew": "",
        "/opt/homebrew/Caskroom/codex/.metadata/INSTALL_RECEIPT.json": JSON.stringify({
          source: { tap: "custom/tap" },
        }),
      },
    });
    expect(target?.latestSource).toMatchObject({
      kind: "brew-local",
      ref: "custom/tap/codex",
      cask: true,
    });
    expect(buildProviderUpdateCommand(target!, "darwin")?.args).toEqual([
      "upgrade",
      "--cask",
      "custom/tap/codex",
    ]);
  });
  it("finds Windows npm in the Node installation when the global prefix is APPDATA", async () => {
    const prefix = "C:\\Users\\test\\AppData\\Roaming\\npm";
    const npmPath = "C:\\Program Files\\nodejs\\npm.cmd";
    const { input, dependencies } = await fixture(
      prefix + "\\node_modules\\@openai\\codex\\bin\\codex.js",
      {
        platform: "win32",
        binaryPath: prefix + "\\codex.cmd",
        files: {
          [npmPath]: "",
          [prefix + "\\node_modules\\@openai\\codex\\package.json"]: '{"name":"@openai/codex"}',
        },
      },
    );
    const target = (await detectProviderInstallTarget(input, {
      ...dependencies,
      resolveExecutable: async (command) => (command === "npm" ? npmPath : input.binaryPath!),
    }))!;
    expect(target.channel).toBe("npm");
    const command = buildProviderUpdateCommand(target, "win32", "1.1.0")!;
    expect(command.executable).toBe(npmPath);
    expect(command.env).toEqual({ NPM_CONFIG_PREFIX: prefix });
    expect(command.pathPrepend).toBe("C:\\Program Files\\nodejs");
    expect(canRunInApp(target, "win32", { isDefault: true })).toBe(false);
  });

  it("uses same-prefix nvm npm and pins the requested version", async () => {
    const { target } = await fixture("/nvm/v24/lib/node_modules/@openai/codex/bin/codex.js", {
      files: npmFiles,
    });
    expect(target?.channel).toBe("npm");
    expect(buildProviderUpdateCommand(target!, "linux", "1.2.3")).toEqual({
      executable: "/nvm/v24/bin/npm",
      args: [
        "install",
        "-g",
        "--allow-scripts=@openai/codex",
        "@openai/codex@1.2.3",
        "--no-audit",
        "--no-fund",
      ],
      channel: "npm",
      shell: "posix",
      pathPrepend: "/nvm/v24/bin",
      env: { NPM_CONFIG_PREFIX: "/nvm/v24" },
    });
  });
  it.each(["/nvm/v24/bin/npm", "/nvm/v24/bin/node"])(
    "requires %s without a PATH fallback",
    async (missing) => {
      const files = { ...npmFiles };
      delete files[missing as keyof typeof files];
      expect(
        (await fixture("/nvm/v24/lib/node_modules/@openai/codex/bin/codex.js", { files })).target
          ?.channel,
      ).toBe("unmanaged");
    },
  );
  it("checks package ownership", async () => {
    expect(
      (
        await fixture("/nvm/v24/lib/node_modules/@openai/codex/bin/codex.js", {
          files: {
            ...npmFiles,
            "/nvm/v24/lib/node_modules/@openai/codex/package.json": '{"name":"other"}',
          },
        })
      ).target?.channel,
    ).toBe("unmanaged");
  });
  it.each([
    "/devbox/bin/codex",
    "/home/test/.volta/tools/image/packages/codex/bin/cli",
    "/home/test/.bun/install/global/node_modules/@openai/codex/bin/codex",
    "/project/node_modules/@openai/codex/bin/codex",
    "/home/test/pnpm/global/cli",
  ])("keeps %s manual", async (file) => {
    const { target } = await fixture(file);
    expect(target?.channel).toBe("unmanaged");
    expect(buildProviderUpdateCommand(target!, "linux", "1.0.0")).toBeNull();
  });
  it.each(["anomalyco/tap", "homebrew/core"])(
    "reads formula tap %s before npm ownership",
    async (tap) => {
      const { target } = await fixture(
        "/opt/homebrew/Cellar/opencode/1.0/libexec/lib/node_modules/opencode-ai/bin/opencode",
        {
          driver: "opencode",
          files: {
            "/opt/homebrew/bin/brew": "",
            "/opt/homebrew/Cellar/opencode/1.0/INSTALL_RECEIPT.json": JSON.stringify({
              source: { tap },
            }),
          },
        },
      );
      expect(target?.channel).toBe("homebrew");
      expect(target?.latestSource?.kind).toBe(
        tap === "homebrew/core" ? "brew-api-formula" : "brew-local",
      );
      expect(buildProviderUpdateCommand(target!, "darwin")?.args).toEqual([
        "upgrade",
        tap === "homebrew/core" ? "opencode" : "anomalyco/tap/opencode",
      ]);
    },
  );
  it("uses the cask API and cask upgrade", async () => {
    const { target } = await fixture("/opt/homebrew/Caskroom/codex/1.0/codex", {
      files: {
        "/opt/homebrew/bin/brew": "",
        "/opt/homebrew/Caskroom/codex/.metadata/INSTALL_RECEIPT.json": "{}",
      },
    });
    expect(target?.latestSource).toEqual({ kind: "brew-api-cask", token: "codex" });
    expect(buildProviderUpdateCommand(target!, "darwin")?.args).toEqual([
      "upgrade",
      "--cask",
      "codex",
    ]);
  });
  it.each([
    {},
    { "/opt/homebrew/bin/brew": "" },
    { "/opt/homebrew/Cellar/codex/1.0/INSTALL_RECEIPT.json": '{"source":{"tap":"homebrew/core"}}' },
  ])("requires both brew and a receipt", async (files) => {
    expect(
      (await fixture("/opt/homebrew/Cellar/codex/1.0/bin/codex", { files })).target?.channel,
    ).toBe("unmanaged");
  });
  it("identifies default Claude as bundled before PATH resolution", async () => {
    const { input, dependencies } = await fixture("/other/claude", {
      driver: "claudeAgent",
      binaryPath: "claude",
    });
    const target = await detectProviderInstallTarget(input, {
      ...dependencies,
      resolveExecutable: async () => {
        throw new Error("must not resolve PATH");
      },
    });
    expect(target?.channel).toBe("bundled");
    expect(buildProviderUpdateCommand(target!, "linux", "1.0.0")).toBeNull();
  });
  it.each([undefined, '"latest"', '"stable"', '"nightly"', "malformed"])(
    "respects native Claude channel %s and the real home",
    async (setting) => {
      const files =
        setting === undefined
          ? {}
          : {
              "/home/test/.claude/settings.json":
                setting === "malformed" ? "{" : `{"autoUpdatesChannel":${setting}}`,
            };
      const { target } = await fixture("/home/test/.local/share/claude/versions/2.0.0", {
        driver: "claudeAgent",
        files,
      });
      expect(target?.channel).toBe("self-update");
      expect(target?.latestSource).toEqual(
        setting === '"nightly"' || setting === "malformed"
          ? null
          : {
              kind: "npm",
              pkg: "@anthropic-ai/claude-code",
              tag: setting === '"stable"' ? "stable" : "latest",
            },
      );
      expect(buildProviderUpdateCommand(target!, "linux")?.executable ?? null).toBe(
        target?.latestSource ? "/bin/cli" : null,
      );
    },
  );
  it("honors an explicit Claude config directory", async () => {
    const { target } = await fixture("/home/test/.local/share/claude/versions/2.0.0", {
      driver: "claudeAgent",
      environment: { CLAUDE_CONFIG_DIR: "/custom" },
      files: { "/custom/settings.json": '{"autoUpdatesChannel":"stable"}' },
    });
    expect(target?.latestSource).toEqual({
      kind: "npm",
      pkg: "@anthropic-ai/claude-code",
      tag: "stable",
    });
  });
  it("uses OpenCode's updater for its native install", async () => {
    const { target } = await fixture("/home/test/.opencode/bin/opencode", { driver: "opencode" });
    expect(buildProviderUpdateCommand(target!, "linux")?.args).toEqual(["upgrade"]);
  });
  it("marks a remote OpenCode server as remotely managed", async () => {
    expect(
      (await fixture("/bin/opencode", { driver: "opencode", serverUrl: "http://localhost:1234" }))
        .target?.channel,
    ).toBe("remote");
  });
  it("resolves Windows npm shims but only provides PowerShell copy commands", async () => {
    const { target } = await fixture("C:\\npm\\node_modules\\@openai\\codex\\bin\\codex.js", {
      platform: "win32",
      binaryPath: "C:\\npm\\codex.cmd",
      files: {
        "C:\\npm\\npm.cmd": "",
        "C:\\npm\\node_modules\\@openai\\codex\\package.json": '{"name":"@openai/codex"}',
      },
    });
    expect(target?.channel).toBe("npm");
    expect(buildProviderUpdateCommand(target!, "win32", "1.0.0")?.shell).toBe("powershell");
    expect(canRunInApp(target!, "win32", { isDefault: true })).toBe(false);
    expect(canRunInApp(target!, "linux", { isDefault: false })).toBe(false);
  });
  it("treats a malformed Windows shim as unmanaged", async () => {
    const { input, dependencies } = await fixture("C:\\codex.cmd", { platform: "win32" });
    expect(
      (
        await detectProviderInstallTarget(input, {
          ...dependencies,
          resolveExecutable: async () => "C:\\codex.cmd",
          resolveInvocation: async () => {
            throw new Error("bad shim");
          },
        })
      )?.channel,
    ).toBe("unmanaged");
  });
  it("returns null when the configured executable cannot be resolved", async () => {
    const { input, dependencies } = await fixture("/missing");
    expect(
      await detectProviderInstallTarget(input, {
        ...dependencies,
        resolveExecutable: async () => null,
      }),
    ).toBeNull();
  });
  it("keeps the same physical key across a real version symlink retarget", async () => {
    const root = realpathSync(mkdtempSync(Path.join(tmpdir(), "f5-install-target-")));
    try {
      const bin = Path.join(root, "claude");
      const versions = ["1.0.0", "2.0.0"].map((version) =>
        Path.join(root, ".local/share/claude/versions", version),
      );
      mkdirSync(Path.dirname(versions[0]!), { recursive: true });
      for (const version of versions) writeFileSync(version, "");
      symlinkSync(versions[0]!, bin);
      const input = {
        driver: ProviderDriverKind.make("claudeAgent"),
        binaryPath: bin,
        resolutionEnvironment: {},
        updateEnvironment: {},
      };
      const deps = {
        homeDir: root,
        platform: process.platform,
        resolveExecutable: async () => bin,
      };
      const first = await detectProviderInstallTarget(input, deps);
      unlinkSync(bin);
      symlinkSync(versions[1]!, bin);
      expect((await detectProviderInstallTarget(input, deps))?.installKey).toBe(first?.installKey);
      expect(first?.channel).toBe("self-update");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

it.each([
  ["latest", "stable"],
  ["stable", "latest"],
] as const)(
  "keeps instance channel %s separate from host channel %s",
  async (instanceChannel, hostChannel) => {
    const { input, dependencies } = await fixture("/home/test/.local/share/claude/versions/2.0.0", {
      driver: "claudeAgent",
      files: {
        "/host/settings.json": JSON.stringify({ autoUpdatesChannel: hostChannel }),
        "/instance/settings.json": JSON.stringify({ autoUpdatesChannel: instanceChannel }),
      },
    });
    vi.stubEnv("CLAUDE_CONFIG_DIR", "/host");
    try {
      const { updateEnvironment: _update, ...resolution } = input;
      const target = await makeInstanceInstallTargetResolver(
        { ...resolution, claudeConfigDir: "/instance", instanceEnvironment: [] },
        dependencies,
      )();
      expect(target?.latestSource).toEqual({
        kind: "npm",
        pkg: "@anthropic-ai/claude-code",
        tag: instanceChannel,
      });
      expect(target?.updateEnvironment.CLAUDE_CONFIG_DIR).toBe("/instance");
      expect(target?.updateEnvironment.HOME).not.toBe("/isolated");
      expect(buildProviderUpdateCommand(target!, "linux")?.env?.CLAUDE_CONFIG_DIR).toBe(
        "/instance",
      );
    } finally {
      vi.unstubAllEnvs();
    }
  },
);

it("only gives each updater its own tooling variables and never provider credentials", () => {
  const environment = {
    PATH: "/bin",
    HOME: "/home",
    HTTPS_PROXY: "http://proxy",
    SSL_CERT_FILE: "/ca",
    npm_config_registry: "https://registry.npmjs.org/",
    HOMEBREW_GITHUB_API_TOKEN: "brew-only",
    CLAUDE_CONFIG_DIR: "/claude",
    OPENAI_API_KEY: "secret",
    ANTHROPIC_API_KEY: "secret",
    GITHUB_TOKEN: "secret",
    AWS_SECRET_ACCESS_KEY: "secret",
    F5_PROFILE_ISOLATED: "1",
    NODE_OPTIONS: "--require=unexpected.js",
  };
  const base = { PATH: "/bin", HOME: "/home", HTTPS_PROXY: "http://proxy", SSL_CERT_FILE: "/ca" };
  expect(filterProviderUpdateEnvironment(environment, "npm")).toEqual({
    ...base,
    NPM_CONFIG_REGISTRY: environment.npm_config_registry,
  });
  expect(filterProviderUpdateEnvironment(environment, "homebrew")).toEqual({
    ...base,
    HOMEBREW_GITHUB_API_TOKEN: "brew-only",
  });
  expect(filterProviderUpdateEnvironment(environment, "self-update")).toEqual({
    ...base,
    CLAUDE_CONFIG_DIR: "/claude",
  });
});

it("updates Grok through `grok update` with the instance's Grok home", async () => {
  const { target } = await fixture("/home/test/.grok/bin/grok", {
    driver: "grok",
    environment: { HOME: "/isolated", GROK_HOME: "/custom/grok", XAI_API_KEY: "secret" },
  });
  expect(target).toMatchObject({
    channel: "self-update",
    installKey: "grok-self-update:/home/test/.grok/bin/grok",
    latestSource: { kind: "npm", pkg: "@xai-official/grok", tag: "latest" },
  });
  expect(target?.blockedReason).toBeUndefined();
  expect(buildProviderUpdateCommand(target!, "linux", "1.2.3")).toMatchObject({
    executable: "/bin/cli",
    args: ["update"],
    env: { GROK_HOME: "/custom/grok" },
    channel: "self-update",
  });
  expect(canRunInApp(target!, "darwin", undefined)).toBe(true);
  const command = buildProviderUpdateCommand(target!, "linux")!;
  expect(
    filterProviderUpdateEnvironment(
      { ...target!.updateEnvironment, ...command.env },
      "self-update",
    ),
  ).toMatchObject({
    GROK_HOME: "/custom/grok",
    NPM_CONFIG_ALLOW_SCRIPTS: "@xai-official/grok",
  });
  expect(filterProviderUpdateEnvironment(target!.updateEnvironment, "self-update")).toEqual({
    HOME: "/isolated",
    GROK_HOME: "/custom/grok",
  });
});

it("updates Grok with the instance's GROK_HOME instead of the host's", async () => {
  const { input, dependencies } = await fixture("/home/test/.grok/bin/grok", { driver: "grok" });
  vi.stubEnv("GROK_HOME", "/host/grok");
  vi.stubEnv("CLAUDE_CONFIG_DIR", "/host/claude");
  try {
    const { updateEnvironment: _update, ...resolution } = input;
    const target = await makeInstanceInstallTargetResolver(
      {
        ...resolution,
        instanceEnvironment: [{ name: "GROK_HOME", value: "/instance/grok", sensitive: false }],
      },
      dependencies,
    )();
    expect(target?.updateEnvironment.GROK_HOME).toBe("/instance/grok");
    expect(target?.updateEnvironment.CLAUDE_CONFIG_DIR).toBeUndefined();
    expect(buildProviderUpdateCommand(target!, "linux")?.env).toEqual({
      GROK_HOME: "/instance/grok",
      NPM_CONFIG_ALLOW_SCRIPTS: "@xai-official/grok",
    });
  } finally {
    vi.unstubAllEnvs();
  }
});

it("gives each self-updater only its own provider home", async () => {
  const environment = { HOME: "/isolated", GROK_HOME: "/grok", CLAUDE_CONFIG_DIR: "/claude" };
  const grok = (await fixture("/home/test/.grok/bin/grok", { driver: "grok", environment }))
    .target!;
  expect(grok.updateEnvironment).toEqual({ HOME: "/isolated", GROK_HOME: "/grok" });
  expect(buildProviderUpdateCommand(grok, "linux")?.env).toEqual({
    GROK_HOME: "/grok",
    NPM_CONFIG_ALLOW_SCRIPTS: "@xai-official/grok",
  });

  const claude = (
    await fixture("/home/test/.local/share/claude/versions/2.0.0", {
      driver: "claudeAgent",
      environment,
      files: { "/claude/settings.json": "{}" },
    })
  ).target!;
  expect(buildProviderUpdateCommand(claude, "linux")?.env).toEqual({
    CLAUDE_CONFIG_DIR: "/claude",
  });

  const pi = (await fixture("/pi/install/bin/pi", { driver: "pi", environment })).target!;
  expect(pi.updateEnvironment).toEqual({ HOME: "/isolated" });
  expect(buildProviderUpdateCommand(pi, "linux")?.env).toBeUndefined();
});

it("updates a Homebrew-installed Grok through its own updater", async () => {
  const { target } = await fixture("/opt/homebrew/Cellar/grok/1.0.0/bin/grok", { driver: "grok" });
  expect(target?.channel).toBe("self-update");
  expect(buildProviderUpdateCommand(target!, "linux")?.args).toEqual(["update"]);
});

it("uses Pi's native self-updater and canonical executable identity", async () => {
  const { target } = await fixture("/pi/install/bin/pi", { driver: "pi" });
  expect(target).toMatchObject({
    channel: "self-update",
    installKey: "pi-self-update:/pi/install/bin/pi",
    latestSource: { kind: "npm", pkg: "@earendil-works/pi-coding-agent", tag: "latest" },
  });
  expect(buildProviderUpdateCommand(target!, "linux", "0.90.0")).toMatchObject({
    executable: "/bin/cli",
    args: ["update", "--self"],
  });
});

it("updates the Cursor CLI through `agent update`", async () => {
  const { target } = await fixture(
    "/home/test/.local/share/cursor-agent/versions/2026.07.09/cursor-agent",
    {
      driver: "cursor",
    },
  );
  expect(target).toMatchObject({
    channel: "self-update",
    installKey:
      "cursor-self-update:/home/test/.local/share/cursor-agent/versions/2026.07.09/cursor-agent",
  });
  expect(target?.blockedReason).toBeUndefined();
  expect(buildProviderUpdateCommand(target!, "linux")).toMatchObject({
    executable: "/bin/cli",
    args: ["update"],
    channel: "self-update",
  });
  // No latest-version source exists, so the advisor offers manual guidance.
  expect(target?.latestSource ?? null).toBeNull();
});

it("does not offer `agent update` for a Cursor binary outside Cursor's installer layout", async () => {
  for (const realPath of ["/usr/local/bin/agent-wrapper.sh", "/opt/homebrew/bin/cursor-agent"]) {
    const { target } = await fixture(realPath, { driver: "cursor" });
    expect(target?.channel).not.toBe("self-update");
  }
});
