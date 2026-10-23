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

function fixture(
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
    resolveExecutable: () => options.binaryPath ?? "/bin/cli",
    realpath: () => realPath,
    resolveInvocation: () => ({ file: "C:\\node.exe", args: [realPath], kind: "npmShim" }),
    exists: (file) => Object.hasOwn(files, file),
    canWrite: () => true,
    readFile: (file) => {
      if (!(file in files)) throw new Error("missing");
      return files[file]!;
    },
    homeDir: "/home/test",
    platform: options.platform ?? "linux",
    bundledExecutable: () => "/f5/sdk/claude",
  };
  return { input, dependencies, target: detectProviderInstallTarget(input, dependencies) };
}
const npmFiles = {
  "/nvm/v24/lib/node_modules/@openai/codex/package.json": '{"name":"@openai/codex"}',
  "/nvm/v24/bin/npm": "",
  "/nvm/v24/bin/node": "",
};

describe("provider installation ownership", () => {
  it("uses one canonical native-install key for different Claude aliases", () => {
    const first = fixture("/home/test/.local/share/claude/versions/2.0.0", {
      driver: "claudeAgent",
      binaryPath: "/bin/claude-alias",
    }).target!;
    const second = fixture("/home/test/.local/share/claude/versions/2.1.0", {
      driver: "claudeAgent",
      binaryPath: "/other/claude",
    }).target!;
    expect(first.installKey).toBe(second.installKey);
    expect(first.executablePath).not.toBe(second.executablePath);
    expect(buildProviderUpdateCommand(first, "linux")?.executable).toBe("/bin/claude-alias");
  });
  it("keeps non-writable npm prefixes copy-only", () => {
    const { input, dependencies } = fixture(
      "/nvm/v24/lib/node_modules/@openai/codex/bin/codex.js",
      { files: npmFiles },
    );
    const target = detectProviderInstallTarget(input, { ...dependencies, canWrite: () => false })!;
    expect(target.channel).toBe("npm");
    expect(target.blockedReason).toBe("permissions");
    expect(canRunInApp(target, "linux", { isDefault: true })).toBe(false);
    expect(buildProviderUpdateCommand(target, "linux", "1.1.0")).not.toBeNull();
  });
  it("keeps third-party cask references qualified for checking and upgrading", () => {
    const { target } = fixture("/opt/homebrew/Caskroom/codex/1.0/codex", {
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
  it("finds Windows npm in the Node installation when the global prefix is APPDATA", () => {
    const prefix = "C:\\Users\\test\\AppData\\Roaming\\npm";
    const npmPath = "C:\\Program Files\\nodejs\\npm.cmd";
    const { input, dependencies } = fixture(
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
    const target = detectProviderInstallTarget(input, {
      ...dependencies,
      resolveExecutable: (command) => (command === "npm" ? npmPath : input.binaryPath!),
    })!;
    expect(target.channel).toBe("npm");
    const command = buildProviderUpdateCommand(target, "win32", "1.1.0")!;
    expect(command.executable).toBe(npmPath);
    expect(command.env).toEqual({ NPM_CONFIG_PREFIX: prefix });
    expect(command.pathPrepend).toBe("C:\\Program Files\\nodejs");
    expect(canRunInApp(target, "win32", { isDefault: true })).toBe(false);
  });

  it("uses same-prefix nvm npm and pins the requested version", () => {
    const { target } = fixture("/nvm/v24/lib/node_modules/@openai/codex/bin/codex.js", {
      files: npmFiles,
    });
    expect(target?.channel).toBe("npm");
    expect(buildProviderUpdateCommand(target!, "linux", "1.2.3")).toEqual({
      executable: "/nvm/v24/bin/npm",
      args: ["install", "-g", "@openai/codex@1.2.3", "--no-audit", "--no-fund"],
      channel: "npm",
      shell: "posix",
      pathPrepend: "/nvm/v24/bin",
      env: { NPM_CONFIG_PREFIX: "/nvm/v24" },
    });
  });
  it.each(["/nvm/v24/bin/npm", "/nvm/v24/bin/node"])(
    "requires %s without a PATH fallback",
    (missing) => {
      const files = { ...npmFiles };
      delete files[missing as keyof typeof files];
      expect(
        fixture("/nvm/v24/lib/node_modules/@openai/codex/bin/codex.js", { files }).target?.channel,
      ).toBe("unmanaged");
    },
  );
  it("checks package ownership", () => {
    expect(
      fixture("/nvm/v24/lib/node_modules/@openai/codex/bin/codex.js", {
        files: {
          ...npmFiles,
          "/nvm/v24/lib/node_modules/@openai/codex/package.json": '{"name":"other"}',
        },
      }).target?.channel,
    ).toBe("unmanaged");
  });
  it.each([
    "/devbox/bin/codex",
    "/home/test/.volta/tools/image/packages/codex/bin/cli",
    "/home/test/.bun/install/global/node_modules/@openai/codex/bin/codex",
    "/project/node_modules/@openai/codex/bin/codex",
    "/home/test/pnpm/global/cli",
  ])("keeps %s manual", (file) => {
    const { target } = fixture(file);
    expect(target?.channel).toBe("unmanaged");
    expect(buildProviderUpdateCommand(target!, "linux", "1.0.0")).toBeNull();
  });
  it.each(["anomalyco/tap", "homebrew/core"])(
    "reads formula tap %s before npm ownership",
    (tap) => {
      const { target } = fixture(
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
  it("uses the cask API and cask upgrade", () => {
    const { target } = fixture("/opt/homebrew/Caskroom/codex/1.0/codex", {
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
  ])("requires both brew and a receipt", (files) => {
    expect(fixture("/opt/homebrew/Cellar/codex/1.0/bin/codex", { files }).target?.channel).toBe(
      "unmanaged",
    );
  });
  it("identifies default Claude as bundled before PATH resolution", () => {
    const { input, dependencies } = fixture("/other/claude", {
      driver: "claudeAgent",
      binaryPath: "claude",
    });
    const target = detectProviderInstallTarget(input, {
      ...dependencies,
      resolveExecutable: () => {
        throw new Error("must not resolve PATH");
      },
    });
    expect(target?.channel).toBe("bundled");
    expect(buildProviderUpdateCommand(target!, "linux", "1.0.0")).toBeNull();
  });
  it.each([undefined, '"latest"', '"stable"', '"nightly"', "malformed"])(
    "respects native Claude channel %s and the real home",
    (setting) => {
      const files =
        setting === undefined
          ? {}
          : {
              "/home/test/.claude/settings.json":
                setting === "malformed" ? "{" : `{"autoUpdatesChannel":${setting}}`,
            };
      const { target } = fixture("/home/test/.local/share/claude/versions/2.0.0", {
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
  it("honors an explicit Claude config directory", () => {
    const { target } = fixture("/home/test/.local/share/claude/versions/2.0.0", {
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
  it("uses OpenCode's updater for its native install", () => {
    const { target } = fixture("/home/test/.opencode/bin/opencode", { driver: "opencode" });
    expect(buildProviderUpdateCommand(target!, "linux")?.args).toEqual(["upgrade"]);
  });
  it("marks a remote OpenCode server as remotely managed", () => {
    expect(
      fixture("/bin/opencode", { driver: "opencode", serverUrl: "http://localhost:1234" }).target
        ?.channel,
    ).toBe("remote");
  });
  it("resolves Windows npm shims but only provides PowerShell copy commands", () => {
    const { target } = fixture("C:\\npm\\node_modules\\@openai\\codex\\bin\\codex.js", {
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
  it("treats a malformed Windows shim as unmanaged", () => {
    const { input, dependencies } = fixture("C:\\codex.cmd", { platform: "win32" });
    expect(
      detectProviderInstallTarget(input, {
        ...dependencies,
        resolveExecutable: () => "C:\\codex.cmd",
        resolveInvocation: () => {
          throw new Error("bad shim");
        },
      })?.channel,
    ).toBe("unmanaged");
  });
  it("returns null when the configured executable cannot be resolved", () => {
    const { input, dependencies } = fixture("/missing");
    expect(
      detectProviderInstallTarget(input, { ...dependencies, resolveExecutable: () => null }),
    ).toBeNull();
  });
  it("keeps the same physical key across a real version symlink retarget", () => {
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
      const deps = { homeDir: root, platform: process.platform, resolveExecutable: () => bin };
      const first = detectProviderInstallTarget(input, deps);
      unlinkSync(bin);
      symlinkSync(versions[1]!, bin);
      expect(detectProviderInstallTarget(input, deps)?.installKey).toBe(first?.installKey);
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
  (instanceChannel, hostChannel) => {
    const { input, dependencies } = fixture("/home/test/.local/share/claude/versions/2.0.0", {
      driver: "claudeAgent",
      files: {
        "/host/settings.json": JSON.stringify({ autoUpdatesChannel: hostChannel }),
        "/instance/settings.json": JSON.stringify({ autoUpdatesChannel: instanceChannel }),
      },
    });
    vi.stubEnv("CLAUDE_CONFIG_DIR", "/host");
    try {
      const { updateEnvironment: _update, ...resolution } = input;
      const target = makeInstanceInstallTargetResolver(
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

it("uses Pi's native self-updater and canonical executable identity", () => {
  const { target } = fixture("/pi/install/bin/pi", { driver: "pi" });
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
