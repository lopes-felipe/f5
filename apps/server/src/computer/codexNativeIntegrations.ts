import { open, realpath as fsRealpath, stat } from "node:fs/promises";
import { join, sep } from "node:path";
import {
  PROVIDER_INTEGRATION_RECORDS,
  type CodexChromeRecord,
  type CodexComputerRecord,
} from "@t3tools/shared/providerIntegrationCertification";
import { CodeSignatureCache, type CodeSignatureResult } from "@t3tools/shared/codeSignature";
import {
  codexChromeDescriptor,
  type ChromeNativeHostDescriptor,
  type ChromeNativeHostRegistration,
} from "../provider/chromeNativeHost";
import { inspectChromeNativeHosts } from "../provider/chromeNativeHostInspection";

/**
 * Read-only inspection of the ChatGPT app's Codex integrations. F5 never enables a
 * plugin, writes a registration, copies a resource, or reads Codex `config.toml` or
 * auth. Global `~/.codex` reads are limited to the record's native-host manifests and
 * their extension-host target.
 */
export const DEFAULT_CHATGPT_APP = "/Applications/ChatGPT.app";
export const CODEX_CHROME_HELPER_STALE = "Open the ChatGPT app once to update its Chrome helper.";
export const CODEX_CHROME_NEEDS_FULL_ACCESS =
  "Codex Chrome needs Full access because its browser runtime runs unsandboxed code.";
export const CODEX_CHROME_NEEDS_ISOLATED_HOME =
  "Codex Chrome needs this agent to use its own Codex home folder in F5.";

const MAX_TEXT_BYTES = 1024 * 1024;
async function readBoundedText(path: string): Promise<string> {
  const file = await open(path, "r");
  try {
    const buffer = Buffer.alloc(MAX_TEXT_BYTES + 1);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead > MAX_TEXT_BYTES) throw new Error("File exceeds the size limit.");
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await file.close();
  }
}

export interface CodexInspectionIo {
  readonly readText: (path: string) => Promise<string>;
  readonly isFile: (path: string) => Promise<boolean>;
  readonly realpath: (path: string) => Promise<string>;
  /** Cheap identity of a file's content and metadata; changes when it is replaced. */
  readonly fingerprint: (path: string) => Promise<string>;
  readonly verify: (
    path: string,
    requirement: { readonly teamId: string; readonly identifier?: string },
  ) => Promise<CodeSignatureResult>;
  readonly inspectRegistrations: (
    descriptor: ChromeNativeHostDescriptor,
    userHome: string,
  ) => Promise<ReadonlyArray<ChromeNativeHostRegistration>>;
}
const signatureCache = new CodeSignatureCache();
export const defaultCodexInspectionIo: CodexInspectionIo = {
  readText: readBoundedText,
  isFile: (path) =>
    stat(path).then(
      (info) => info.isFile(),
      () => false,
    ),
  realpath: fsRealpath,
  fingerprint: async (path) => {
    const info = await stat(path);
    return `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
  },
  // Deep verification of ChatGPT.app is slow; a result is reused only while the bundle's
  // identity and signature seal are unchanged, so an update is always verified again.
  verify: (path, requirement) => signatureCache.probe(path, requirement),
  inspectRegistrations: (descriptor, userHome) =>
    inspectChromeNativeHosts(descriptor.locations("", userHome)),
};

/** Dotted numeric versions (`26.1013.40934`); non-numeric parts make the range unsatisfiable. */
export function versionInRange(version: string, min: string, max: string): boolean {
  const parse = (value: string) => {
    const parts = value.split(".").map((part) => (/^\d+$/.test(part) ? Number(part) : Number.NaN));
    return parts.some(Number.isNaN) ? undefined : parts;
  };
  const compare = (a: number[], b: number[]) => {
    for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
      const delta = (a[index] ?? 0) - (b[index] ?? 0);
      if (delta) return delta;
    }
    return 0;
  };
  const [value, low, high] = [parse(version), parse(min), parse(max)];
  return !!value && !!low && !!high && compare(value, low) >= 0 && compare(value, high) <= 0;
}

function plistString(plist: string, key: string): string | undefined {
  const match = new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`).exec(plist);
  return match?.[1];
}

export type CodexInspectionFailure = {
  readonly available: false;
  readonly reason: string;
  readonly state:
    | "unsupported-platform"
    | "not-installed"
    | "signature"
    | "version"
    | "malformed"
    | "helper-stale"
    | "registration";
};

export interface CodexChromeInstallation {
  readonly available: true;
  readonly record: CodexChromeRecord;
  readonly appPath: string;
  readonly appVersion: string;
  readonly pluginRoot: string;
  readonly pluginVersion: string;
  readonly skillPath: string;
  readonly serviceScript: string;
  readonly nodeRepl: string;
  readonly nodePath: string;
  readonly nodeModules: string;
  /** The versioned cache path registrations launch, and what it resolved to. */
  readonly hostLink: string;
  readonly hostTarget: string;
  readonly hostFingerprint: string;
  readonly descriptor: ChromeNativeHostDescriptor;
  /** Snapshot at inspection; drift later makes the session unhealthy. */
  readonly registrations: ReadonlyArray<Omit<ChromeNativeHostRegistration, "bytes">>;
}

const fail = (state: CodexInspectionFailure["state"], reason: string): CodexInspectionFailure => ({
  available: false,
  state,
  reason,
});

async function inspectApp(
  appPath: string,
  identity: { readonly teamId: string; readonly appIdentifier: string },
  io: CodexInspectionIo,
): Promise<{ version: string } | CodexInspectionFailure> {
  let plist: string;
  try {
    plist = await io.readText(join(appPath, "Contents", "Info.plist"));
  } catch {
    return fail("not-installed", "Install the ChatGPT app to use this integration.");
  }
  const version = plistString(plist, "CFBundleShortVersionString");
  if (!version || plistString(plist, "CFBundleIdentifier") !== identity.appIdentifier)
    return fail("malformed", "The installed ChatGPT app isn't the expected build.");
  const signature = await io.verify(appPath, {
    teamId: identity.teamId,
    identifier: identity.appIdentifier,
  });
  if (!signature.ok) return fail("signature", "The ChatGPT app's signature could not be verified.");
  return { version };
}

/** Each requirement is checked in order; the first failure names what to fix. */
export async function inspectCodexChrome(input: {
  readonly platform?: string;
  readonly arch?: string;
  readonly chatGptApp?: string;
  readonly userHome: string;
  readonly record?: CodexChromeRecord;
  readonly io?: CodexInspectionIo;
}): Promise<CodexChromeInstallation | CodexInspectionFailure> {
  const platform = input.platform ?? process.platform;
  const arch = input.arch ?? process.arch;
  const io = input.io ?? defaultCodexInspectionIo;
  if (platform !== "darwin")
    return fail(
      "unsupported-platform",
      "Codex Chrome control isn't supported on this operating system yet.",
    );
  const record =
    input.record ??
    PROVIDER_INTEGRATION_RECORDS["codex-chrome"].find(
      (entry) => entry.platform === platform && entry.arch === arch && !entry.withdrawn,
    );
  if (!record)
    return fail("version", "Codex Chrome control is not certified on this Mac's architecture yet.");
  const identity = record.identity;
  const appPath = input.chatGptApp ?? DEFAULT_CHATGPT_APP;
  const app = await inspectApp(appPath, identity, io);
  if ("available" in app) return app;
  if (!versionInRange(app.version, record.versions.appMin!, record.versions.appMax!))
    return fail(
      "version",
      `This ChatGPT app version (${app.version}) isn't certified with F5 yet.`,
    );

  const resources = join(appPath, "Contents", "Resources");
  const pluginRoot = join(resources, "plugins", "openai-bundled", "plugins", "chrome");
  let pluginVersion: string;
  let skillPath: string;
  try {
    const plugin = JSON.parse(
      await io.readText(join(pluginRoot, ".codex-plugin", "plugin.json")),
    ) as {
      name?: unknown;
      version?: unknown;
    };
    if (plugin.name !== "chrome" || typeof plugin.version !== "string") throw new Error("plugin");
    pluginVersion = plugin.version;
    const ids = JSON.parse(
      await io.readText(join(pluginRoot, "scripts", "extension-ids.json")),
    ) as {
      extensionHostName?: unknown;
      extensionIds?: unknown;
    };
    const origins = Array.isArray(ids.extensionIds)
      ? ids.extensionIds.map((id) => `chrome-extension://${String(id)}/`).sort()
      : [];
    if (
      ids.extensionHostName !== identity.hostName ||
      JSON.stringify(origins) !== JSON.stringify([...identity.allowedOrigins].sort())
    )
      return fail("malformed", "The ChatGPT app's Chrome extension identity changed. Update F5.");
    const skills = join(pluginRoot, "skills", "control-chrome", "SKILL.md");
    for (const file of ["browser-client.mjs", "browser-service.mjs"])
      if (!(await io.isFile(join(pluginRoot, "scripts", file)))) throw new Error(file);
    if (!(await io.isFile(skills))) throw new Error("SKILL.md");
    skillPath = skills;
  } catch {
    return fail(
      "malformed",
      "The ChatGPT app's Chrome plugin is incomplete. Reinstall the ChatGPT app.",
    );
  }
  if (!versionInRange(pluginVersion, record.versions.pluginMin!, record.versions.pluginMax!))
    return fail(
      "version",
      `This ChatGPT Chrome plugin version (${pluginVersion}) isn't certified with F5 yet.`,
    );

  const nodeRepl = join(resources, "cua_node", "bin", "node_repl");
  const nodeReplSignature = await io.verify(nodeRepl, {
    teamId: identity.teamId,
    identifier: "node_repl",
  });
  if (!nodeReplSignature.ok)
    return fail("signature", "The ChatGPT app's browser runtime signature could not be verified.");

  // The helper the registrations launch: the ChatGPT app copies it per plugin version.
  const cacheRoot = join(input.userHome, ".codex", "plugins", "cache", "openai-bundled", "chrome");
  const expectedTarget = join(
    cacheRoot,
    pluginVersion,
    identity.hostIdentifier,
    "macos",
    arch,
    "ChatGPT for Chrome",
  );
  let hostTarget: string;
  let hostFingerprint: string;
  try {
    hostTarget = await io.realpath(expectedTarget);
    const canonicalCache = await io.realpath(cacheRoot);
    if (!hostTarget.startsWith(canonicalCache + sep)) throw new Error("outside");
    // Taken before the signature check, so a swap after it is still detected.
    hostFingerprint = await io.fingerprint(hostTarget);
  } catch {
    return fail("helper-stale", CODEX_CHROME_HELPER_STALE);
  }
  const hostSignature = await io.verify(hostTarget, {
    teamId: identity.teamId,
    identifier: identity.hostIdentifier,
  });
  if (!hostSignature.ok) return fail("helper-stale", CODEX_CHROME_HELPER_STALE);

  const descriptor = codexChromeDescriptor(record, () => hostTarget);
  const registrations = await io.inspectRegistrations(descriptor, input.userHome);
  const allowed = new Set(identity.allowedOrigins);
  let registered = 0;
  for (const entry of registrations) {
    if (entry.shadowed || entry.state === "absent") continue;
    if (entry.state !== "ok")
      return fail("registration", "A Chrome helper registration couldn't be read.");
    if (!(entry.allowedOrigins ?? []).every((origin) => allowed.has(origin)))
      return fail("registration", "A Chrome helper registration allows unexpected extensions.");
    const target = await io.realpath(entry.targetPath!).catch(() => undefined);
    if (target !== hostTarget) return fail("helper-stale", CODEX_CHROME_HELPER_STALE);
    registered += 1;
  }
  if (!registered)
    return fail("registration", "Set up the ChatGPT Chrome extension from the ChatGPT app first.");
  return {
    available: true,
    record,
    appPath,
    appVersion: app.version,
    pluginRoot,
    pluginVersion,
    skillPath,
    serviceScript: join(pluginRoot, "scripts", "browser-service.mjs"),
    nodeRepl,
    nodePath: join(resources, "cua_node", "bin", "node"),
    nodeModules: join(resources, "cua_node", "lib", "node_modules"),
    hostLink: expectedTarget,
    hostTarget,
    hostFingerprint,
    descriptor,
    registrations: registrations.map(({ bytes: _bytes, ...entry }) => entry),
  };
}

/**
 * Same registrations (content hashes) and the same signature-checked helper (its `latest`
 * link and file identity) as at inspection, or the session becomes unhealthy.
 */
export async function codexChromeRegistrationsUnchanged(
  installation: CodexChromeInstallation,
  userHome: string,
  io: CodexInspectionIo = defaultCodexInspectionIo,
): Promise<boolean> {
  const current = await io.inspectRegistrations(installation.descriptor, userHome);
  const key = (entries: ReadonlyArray<Omit<ChromeNativeHostRegistration, "bytes">>) =>
    JSON.stringify(entries.map((entry) => [entry.location, entry.state, entry.sha256 ?? null]));
  if (key(current) !== key(installation.registrations)) return false;
  try {
    return (
      (await io.realpath(installation.hostLink)) === installation.hostTarget &&
      (await io.fingerprint(installation.hostTarget)) === installation.hostFingerprint
    );
  } catch {
    return false;
  }
}

/** The same app, plugin, runtime and helper a session was verified with. */
export function codexChromeInstallationUnchanged(
  verified: CodexChromeInstallation,
  current: CodexChromeInstallation,
): boolean {
  return (
    verified.appVersion === current.appVersion &&
    verified.pluginVersion === current.pluginVersion &&
    verified.nodeRepl === current.nodeRepl &&
    verified.hostTarget === current.hostTarget &&
    verified.hostFingerprint === current.hostFingerprint
  );
}

/** Environment for the browser runtime child; no credentials and no F5 secrets. */
export function codexChromeChildEnvironment(
  installation: CodexChromeInstallation,
  codexHome: string,
  base: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  return {
    ...(base.PATH ? { PATH: base.PATH } : {}),
    ...(base.HOME ? { HOME: base.HOME } : {}),
    ...(base.USER ? { USER: base.USER } : {}),
    ...(base.TMPDIR ? { TMPDIR: base.TMPDIR } : {}),
    CODEX_HOME: codexHome,
    NODE_REPL_NODE_PATH: installation.nodePath,
    NODE_REPL_NODE_MODULE_DIRS: installation.nodeModules,
    NODE_REPL_TRUSTED_CODE_PATHS: `${installation.pluginRoot}:${installation.nodeModules}`,
    NODE_REPL_TRUSTED_SERVICES: JSON.stringify({ browser: installation.serviceScript }),
    BROWSER_USE_AVAILABLE_BACKENDS: "chrome",
    NODE_REPL_NATIVE_PIPE_CONNECT_TIMEOUT_MS: "1000",
    BROWSER_USE_CODEX_APP_VERSION: installation.appVersion,
    BROWSER_USE_CODEX_APP_BUILD_FLAVOR: "prod",
  };
}

/** Appended to the session's developer instructions so Codex can find the skill. */
export function codexChromeInstructions(installation: CodexChromeInstallation): string {
  return [
    "Chrome control is available through the `node_repl` MCP server's `js` tool.",
    `Before using it, read the skill at ${installation.skillPath}.`,
    `The Chrome plugin's files are under ${installation.pluginRoot}.`,
  ].join(" ");
}

export interface CodexComputerInstallation {
  readonly available: true;
  readonly record: CodexComputerRecord;
  readonly appPath: string;
  readonly serviceAppPath: string;
  readonly clientPath: string;
  readonly version: string;
}

/**
 * Sky (Codex Computer Use) identity: the ChatGPT app, the CUAService app and its MCP
 * client. Paths come from the certification record; with no record nothing is read.
 */
export async function inspectCodexComputer(input: {
  readonly platform?: string;
  readonly arch?: string;
  readonly chatGptApp?: string;
  readonly userHome: string;
  readonly record?: CodexComputerRecord;
  readonly io?: CodexInspectionIo;
}): Promise<CodexComputerInstallation | CodexInspectionFailure> {
  const platform = input.platform ?? process.platform;
  const arch = input.arch ?? process.arch;
  const io = input.io ?? defaultCodexInspectionIo;
  if (platform !== "darwin")
    return fail(
      "unsupported-platform",
      "Codex Computer Use isn't supported on this operating system yet.",
    );
  const record =
    input.record ??
    PROVIDER_INTEGRATION_RECORDS["codex-computer"].find(
      (entry) => entry.platform === platform && entry.arch === arch && !entry.withdrawn,
    );
  if (!record)
    return fail(
      "version",
      "Codex Computer Use is awaiting a live safety certification for this F5 build.",
    );
  const identity = record.identity;
  const appPath = input.chatGptApp ?? DEFAULT_CHATGPT_APP;
  const app = await inspectApp(appPath, identity, io);
  if ("available" in app) return app;
  const versions = record.versions;
  if (!versionInRange(app.version, versions.appMin!, versions.appMax!))
    return fail(
      "version",
      `This ChatGPT app version (${app.version}) isn't certified with F5 yet.`,
    );
  const serviceAppPath = join(
    input.userHome,
    ...(versions.serviceAppPath ?? "").split("/").filter(Boolean),
  );
  const clientPath = join(
    serviceAppPath,
    ...(versions.clientPath ?? "").split("/").filter(Boolean),
  );
  if (!versions.serviceAppPath || !versions.clientPath || !(await io.isFile(clientPath)))
    return fail("not-installed", "Set up Computer Use in the ChatGPT app first.");
  let plist: string;
  try {
    plist = await io.readText(join(serviceAppPath, "Contents", "Info.plist"));
  } catch {
    return fail("not-installed", "Set up Computer Use in the ChatGPT app first.");
  }
  const version = plistString(plist, "CFBundleShortVersionString");
  if (!version || !versionInRange(version, versions.serviceMin!, versions.serviceMax!))
    return fail("version", "This Computer Use version isn't certified with F5 yet.");
  const signature = await io.verify(serviceAppPath, {
    teamId: identity.teamId,
    identifier: identity.serviceIdentifier,
  });
  if (!signature.ok) return fail("signature", "Computer Use's signature could not be verified.");
  const client = await io.verify(clientPath, { teamId: identity.teamId });
  if (!client.ok)
    return fail("signature", "Computer Use's client signature could not be verified.");
  return { available: true, record, appPath, serviceAppPath, clientPath, version };
}
