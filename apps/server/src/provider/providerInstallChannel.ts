import { accessSync, constants, existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import * as Path from "node:path";
import type {
  ActiveProfile,
  ProviderDriverKind,
  ProviderInstanceEnvironment,
  ServerProviderUpdateCommand,
} from "@t3tools/contracts";
import { buildProviderChildProcessEnv } from "../providerProcessEnv.ts";
import { resolveExecutable, resolveInvocation } from "../spawn/resolveCommand.ts";
import { isDefaultClaudeBinary, resolveBundledClaudeExecutable } from "./claudeSdkExecutable.ts";

export const NPM_UPDATE_SOURCES: Readonly<Record<string, string>> = {
  codex: "@openai/codex",
  claudeAgent: "@anthropic-ai/claude-code",
  opencode: "opencode-ai",
  pi: "@earendil-works/pi-coding-agent",
};

export type ProviderLatestSource =
  | { readonly kind: "npm"; readonly pkg: string; readonly tag: "latest" | "stable" }
  | { readonly kind: "brew-api-formula"; readonly name: string }
  | { readonly kind: "brew-api-cask"; readonly token: string }
  | {
      readonly kind: "brew-local";
      readonly brewExecutable: string;
      readonly ref: string;
      readonly cask: boolean;
    };

export interface ProviderInstallTarget {
  readonly channel: "bundled" | "npm" | "homebrew" | "self-update" | "unmanaged" | "remote";
  readonly executablePath: string;
  readonly realPath: string;
  readonly updateEnvironment: NodeJS.ProcessEnv;
  readonly installKey: string;
  readonly latestSource: ProviderLatestSource | null;
  readonly sourceKey: string | null;
  readonly guidance: string;
  readonly blockedReason?:
    | "custom_registry"
    | "registry_unverified"
    | "permissions"
    | "unsupported_source"
    | "remote";
  readonly npm?: { readonly prefix: string; readonly pkg: string; readonly npmPath: string };
  readonly brew?: { readonly executable: string; readonly ref: string; readonly cask: boolean };
  readonly selfUpdateArgs?: ReadonlyArray<string>;
}

export interface DetectProviderInstallTargetInput {
  readonly driver: ProviderDriverKind;
  readonly binaryPath?: string | undefined;
  readonly serverUrl?: string | undefined;
  readonly instanceId?: string | undefined;
  readonly resolutionEnvironment: NodeJS.ProcessEnv;
  readonly updateEnvironment: NodeJS.ProcessEnv;
}

export interface InstallTargetDependencies {
  readonly resolveExecutable: typeof resolveExecutable;
  readonly resolveInvocation: typeof resolveInvocation;
  readonly realpath: (path: string) => string;
  readonly exists: (path: string) => boolean;
  readonly readFile: (path: string) => string;
  readonly canWrite: (path: string) => boolean;
  readonly bundledExecutable: () => string;
  readonly homeDir: string;
  readonly platform: NodeJS.Platform;
}

/** Classification has no process side effects. Registry ownership is checked privately by the advisor. */
export function detectProviderInstallTarget(
  input: DetectProviderInstallTargetInput,
  dependencies: Partial<InstallTargetDependencies> = {},
): ProviderInstallTarget | null {
  const deps: InstallTargetDependencies = {
    resolveExecutable,
    resolveInvocation,
    realpath: realpathSync,
    exists: existsSync,
    canWrite: (path) => {
      try {
        accessSync(path, constants.W_OK);
        return true;
      } catch {
        return false;
      }
    },
    readFile: (path) => readFileSync(path, "utf8"),
    bundledExecutable: resolveBundledClaudeExecutable,
    homeDir: homedir(),
    platform: process.platform,
    ...dependencies,
  };
  const path = deps.platform === "win32" ? Path.win32 : Path.posix;
  const pkg = NPM_UPDATE_SOURCES[input.driver];
  const npmSource: ProviderLatestSource | null = pkg ? { kind: "npm", pkg, tag: "latest" } : null;
  const readJson = (file: string): Record<string, unknown> | null => {
    try {
      const value: unknown = JSON.parse(deps.readFile(file));
      return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  };
  const make = (
    channel: ProviderInstallTarget["channel"],
    executablePath: string,
    realPath: string,
    installKey: string,
    latestSource: ProviderLatestSource | null,
    guidance: string,
    extra: Partial<ProviderInstallTarget> = {},
  ): ProviderInstallTarget => ({
    channel,
    executablePath,
    realPath,
    installKey,
    latestSource,
    sourceKey: latestSource ? JSON.stringify(latestSource) : null,
    updateEnvironment: input.updateEnvironment,
    guidance,
    ...extra,
  });
  if (input.driver === "opencode" && input.serverUrl?.trim())
    return make(
      "remote",
      "",
      "",
      `remote:${input.instanceId ?? input.serverUrl}`,
      null,
      "Update OpenCode on the machine hosting the remote server, then refresh and verify.",
      { blockedReason: "remote" },
    );
  if (input.driver === "claudeAgent" && isDefaultClaudeBinary(input.binaryPath)) {
    let executable = "";
    try {
      executable = deps.bundledExecutable();
    } catch {
      /* Keep the bundled policy visible offline. */
    }
    return make("bundled", executable, executable, "bundled", npmSource, "Bundled with F5.");
  }
  const command =
    input.binaryPath?.trim() || (input.driver === "claudeAgent" ? "claude" : input.driver);
  const executable = deps.resolveExecutable(command, input.resolutionEnvironment, {
    platform: deps.platform,
    useCache: false,
  });
  if (!executable) return null;
  let resolved = executable;
  try {
    if (deps.platform === "win32" && /\.cmd$/i.test(executable)) {
      const invocation = deps.resolveInvocation(executable, [], input.resolutionEnvironment, {
        platform: deps.platform,
        useCache: false,
      });
      resolved = invocation.args[0] ?? executable;
    }
    resolved = deps.realpath(resolved);
  } catch {
    return make(
      "unmanaged",
      executable,
      resolved,
      `unmanaged:${resolved}`,
      npmSource,
      "F5 could not identify this executable. Update it using its original installer, then refresh and verify.",
      { blockedReason: "unsupported_source" },
    );
  }
  if (input.driver === "pi")
    return make(
      "self-update",
      executable,
      resolved,
      `pi-self-update:${resolved}`,
      npmSource,
      "Update with Pi's built-in updater: pi update --self.",
      {
        selfUpdateArgs: ["update", "--self"],
        ...(!deps.canWrite(path.dirname(resolved))
          ? { blockedReason: "permissions" as const }
          : {}),
      },
    );
  const unmanaged = (
    guidance = "Update this CLI using its original installer, then refresh and verify.",
    blockedReason: "unsupported_source" | "custom_registry" = "unsupported_source",
  ) =>
    make("unmanaged", executable, resolved, `unmanaged:${resolved}`, npmSource, guidance, {
      blockedReason,
    });
  // Homebrew packages can themselves contain node_modules; keg ownership takes precedence.
  const normalized = resolved.replaceAll("\\", "/");
  const formula = /^(.*)\/Cellar\/([^/]+)\/([^/]+)\//.exec(normalized);
  const cask = /^(.*)\/Caskroom\/([^/]+)\//.exec(normalized);
  if (formula || cask) {
    const match = (formula ?? cask)!;
    const prefix = match[1]!;
    const name = match[2]!;
    const brewExecutable = `${prefix}/bin/brew`;
    const receiptPath = formula
      ? `${prefix}/Cellar/${name}/${match[3]}/INSTALL_RECEIPT.json`
      : `${prefix}/Caskroom/${name}/.metadata/INSTALL_RECEIPT.json`;
    const receipt = readJson(receiptPath);
    if (!receipt || !deps.exists(brewExecutable)) return unmanaged();
    const source = receipt.source as { tap?: unknown } | undefined;
    const tap = typeof source?.tap === "string" ? source.tap : cask ? "homebrew/cask" : null;
    if (!tap) return unmanaged();
    const core = tap === (cask ? "homebrew/cask" : "homebrew/core");
    const ref = core ? name : `${tap}/${name}`;
    const latestSource: ProviderLatestSource = core
      ? cask
        ? { kind: "brew-api-cask", token: name }
        : { kind: "brew-api-formula", name }
      : { kind: "brew-local", brewExecutable, ref: `${tap}/${name}`, cask: !!cask };
    return make(
      "homebrew",
      executable,
      resolved,
      cask ? `brew-cask:${prefix}:${name}` : `brew-formula:${prefix}:${tap}/${name}`,
      latestSource,
      "Update using the Homebrew installation that owns this executable.",
      { brew: { executable: brewExecutable, ref, cask: !!cask } },
    );
  }
  if (normalized.includes("/.devbox/"))
    return unmanaged(
      "Update this CLI using the devbox installation that owns this executable, then refresh and verify.",
    );
  if (normalized.includes("/.volta/"))
    return unmanaged("Update this CLI using Volta, then refresh and verify.");
  if (normalized.includes("/.bun/install/"))
    return unmanaged(
      "Update this CLI using Bun's global package manager, then refresh and verify.",
    );
  if (normalized.includes("/pnpm/"))
    return unmanaged(
      "Update this CLI using pnpm's global package manager, then refresh and verify.",
    );
  if (pkg) {
    const marker =
      deps.platform === "win32"
        ? `\\node_modules\\${pkg.replaceAll("/", "\\")}\\`
        : `/lib/node_modules/${pkg}/`;
    const index = resolved.indexOf(marker);
    if (index >= 0) {
      const prefix = resolved.slice(0, index);
      const packageRoot = path.join(
        prefix,
        deps.platform === "win32" ? "node_modules" : "lib/node_modules",
        pkg,
      );
      const prefixNpm = path.join(prefix, deps.platform === "win32" ? "npm.cmd" : "bin/npm");
      // Windows separates the global package prefix from the Node installation; copy-only uses its npm.
      const npmPath =
        deps.platform === "win32" && !deps.exists(prefixNpm)
          ? deps.resolveExecutable("npm", input.resolutionEnvironment, {
              platform: deps.platform,
              useCache: false,
            })
          : prefixNpm;
      const nodePath = path.join(prefix, deps.platform === "win32" ? "node.exe" : "bin/node");
      if (
        readJson(path.join(packageRoot, "package.json"))?.name !== pkg ||
        !npmPath ||
        !deps.exists(npmPath) ||
        (deps.platform !== "win32" && !deps.exists(nodePath))
      )
        return unmanaged();
      const writable =
        deps.platform === "win32" || deps.canWrite(path.join(prefix, "lib/node_modules"));
      return make(
        "npm",
        executable,
        resolved,
        `npm:${prefix}:${pkg}`,
        npmSource,
        writable
          ? "Update the public npm package in its existing global prefix."
          : "F5 cannot write to this npm installation. Run the copied command with the permissions required by its original installer, then refresh and verify.",
        { npm: { prefix, pkg, npmPath }, ...(!writable ? { blockedReason: "permissions" } : {}) },
      );
    }
  }
  if (normalized.includes("/node_modules/")) return unmanaged();
  const under = (root: string) => resolved.startsWith(root + path.sep);
  if (
    input.driver === "claudeAgent" &&
    under(path.join(deps.homeDir, ".local/share/claude/versions"))
  ) {
    const settingsPath = path.join(
      input.updateEnvironment.CLAUDE_CONFIG_DIR ?? path.join(deps.homeDir, ".claude"),
      "settings.json",
    );
    const settings = deps.exists(settingsPath) ? readJson(settingsPath) : {};
    const channel = settings ? (settings.autoUpdatesChannel ?? "latest") : null;
    const source: ProviderLatestSource | null =
      channel === "latest" || channel === "stable"
        ? { kind: "npm", pkg: NPM_UPDATE_SOURCES.claudeAgent!, tag: channel }
        : null;
    return make(
      "self-update",
      executable,
      resolved,
      `self-update:${path.join(deps.homeDir, ".local/share/claude")}`,
      source,
      source
        ? "Update with Claude's built-in updater."
        : "Claude's update channel could not be read. Check autoUpdatesChannel in Claude settings, update manually, then refresh and verify.",
      source ? { selfUpdateArgs: ["update"] } : { blockedReason: "unsupported_source" },
    );
  }
  if (input.driver === "opencode" && under(path.join(deps.homeDir, ".opencode/bin")))
    return make(
      "self-update",
      executable,
      resolved,
      `self-update:${path.join(deps.homeDir, ".opencode")}`,
      npmSource,
      "Update with OpenCode's built-in updater.",
      { selfUpdateArgs: ["upgrade"] },
    );
  return unmanaged();
}

/** Installers need OS/tooling configuration, never the provider's API credentials. */
export function filterProviderUpdateEnvironment(
  environment: NodeJS.ProcessEnv,
  channel?: ServerProviderUpdateCommand["channel"],
): NodeJS.ProcessEnv {
  const allowed = new Set([
    "PATH",
    "HOME",
    "USERPROFILE",
    "HOMEDRIVE",
    "HOMEPATH",
    "SYSTEMROOT",
    "WINDIR",
    "COMSPEC",
    "PATHEXT",
    "TEMP",
    "TMP",
    "TMPDIR",
    "USER",
    "LOGNAME",
    "SHELL",
    "LANG",
    "LANGUAGE",
    "TERM",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "NO_PROXY",
    "NODE_EXTRA_CA_CERTS",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "CURL_CA_BUNDLE",
    "REQUESTS_CA_BUNDLE",
    "NONINTERACTIVE",
  ]);
  const result: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(environment)) {
    const upper = key.toUpperCase();
    if (
      allowed.has(upper) ||
      upper.startsWith("LC_") ||
      ((channel === undefined || channel === "npm") && upper.startsWith("NPM_CONFIG_")) ||
      ((channel === undefined || channel === "homebrew") && upper.startsWith("HOMEBREW_")) ||
      ((channel === undefined || channel === "self-update") && upper === "CLAUDE_CONFIG_DIR")
    )
      result[upper.startsWith("NPM_CONFIG_") ? upper : key] = value;
  }
  return result;
}

export function makeInstanceInstallTargetResolver(
  input: Omit<DetectProviderInstallTargetInput, "updateEnvironment"> & {
    readonly instanceEnvironment: ProviderInstanceEnvironment;
    readonly claudeConfigDir?: string | undefined;
  },
  dependencies: Partial<InstallTargetDependencies> = {},
): () => ProviderInstallTarget | null {
  return () => {
    const base = { ...process.env };
    for (const key of Object.keys(base))
      if (key.toUpperCase() === "F5_PROFILE_ISOLATED") delete base[key];
    const updateEnvironment = filterProviderUpdateEnvironment(
      buildProviderChildProcessEnv(
        base,
        Object.fromEntries(
          input.instanceEnvironment.map((variable) => [variable.name, variable.value]),
        ),
      ),
    );
    if (input.claudeConfigDir) updateEnvironment.CLAUDE_CONFIG_DIR = input.claudeConfigDir;
    for (const key of Object.keys(updateEnvironment))
      if (key.toUpperCase() === "F5_PROFILE_ISOLATED") delete updateEnvironment[key];
    return detectProviderInstallTarget({ ...input, updateEnvironment }, dependencies);
  };
}

export function buildProviderUpdateCommand(
  target: ProviderInstallTarget,
  platform: NodeJS.Platform,
  latestVersion?: string | null,
): ServerProviderUpdateCommand | null {
  const shell = platform === "win32" ? "powershell" : "posix";
  if (target.channel === "npm" && target.npm && latestVersion)
    return {
      executable: target.npm.npmPath,
      args: ["install", "-g", `${target.npm.pkg}@${latestVersion}`, "--no-audit", "--no-fund"],
      env: { NPM_CONFIG_PREFIX: target.npm.prefix },
      pathPrepend: (platform === "win32" ? Path.win32 : Path.posix).dirname(target.npm.npmPath),
      channel: "npm",
      shell,
    };
  if (target.channel === "homebrew" && target.brew)
    return {
      executable: target.brew.executable,
      args: ["upgrade", ...(target.brew.cask ? ["--cask"] : []), target.brew.ref],
      channel: "homebrew",
      shell,
    };
  if (target.channel === "self-update" && target.selfUpdateArgs)
    return {
      executable: target.executablePath,
      args: target.selfUpdateArgs,
      ...(target.updateEnvironment.CLAUDE_CONFIG_DIR
        ? { env: { CLAUDE_CONFIG_DIR: target.updateEnvironment.CLAUDE_CONFIG_DIR } }
        : {}),
      channel: "self-update",
      shell,
    };
  return null;
}

export function canRunInApp(
  target: ProviderInstallTarget,
  platform: NodeJS.Platform,
  profile: Pick<ActiveProfile, "isDefault"> | undefined,
): boolean {
  return (
    (platform === "darwin" || platform === "linux") &&
    (profile?.isDefault ?? true) &&
    !target.blockedReason &&
    (target.channel === "npm" ||
      target.channel === "homebrew" ||
      (target.channel === "self-update" && !!target.selfUpdateArgs))
  );
}
