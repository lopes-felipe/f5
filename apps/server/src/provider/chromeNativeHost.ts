import { createHash } from "node:crypto";
import { join } from "node:path";
import type {
  ClaudeChromeRecord,
  CodexChromeRecord,
} from "@t3tools/shared/providerIntegrationCertification";
import type { ChromeNativeHostLocation } from "./chromeNativeHostInspection";

export type ChromeProvider = "claude" | "codex";

export interface ChromeServerStatus {
  readonly name?: unknown;
  readonly status?: unknown;
  readonly source?: unknown;
  readonly scope?: unknown;
  readonly config?: unknown;
  readonly tools?: unknown;
}

/** Built from one certification record; never from guesses. */
export interface ChromeNativeHostDescriptor {
  readonly provider: ChromeProvider;
  readonly recordId: string;
  /** `provider-cli` writes registrations itself (Claude); `external` never writes (Codex). */
  readonly registrationOwner: "provider-cli" | "external";
  readonly hostNames: ReadonlyArray<string>;
  readonly allowedOrigins: ReadonlyArray<string>;
  readonly browsers: ReadonlyArray<string>;
  readonly expectedTarget: (providerHome: string) => string;
  readonly locations: (
    providerHome: string,
    userHome: string,
  ) => ReadonlyArray<ChromeNativeHostLocation>;
  readonly verifyWrapper?: (
    bytes: string,
    executableRealpath: string,
    realpath: (path: string) => Promise<string>,
  ) => Promise<boolean>;
  readonly verifyServer?: (
    status: ChromeServerStatus | undefined,
    context: {
      readonly executableRealpath: string;
      readonly toolNames: ReadonlyArray<string>;
      readonly realpath: (path: string) => Promise<string>;
    },
  ) => Promise<boolean>;
}

export interface ChromeNativeHostRegistration {
  readonly browser: string;
  readonly location: string;
  readonly state: "absent" | "ok" | "unreadable" | "malformed";
  readonly bytes?: string;
  readonly sha256?: string;
  readonly targetPath?: string;
  readonly allowedOrigins?: ReadonlyArray<string>;
  readonly shadowed?: boolean;
  readonly hostName?: string;
}

export const sha256 = (bytes: string): string => createHash("sha256").update(bytes).digest("hex");

/**
 * Inverse of the CLI's shell quoting: a token is bare when it matches the safe set,
 * otherwise single-quoted with `'` written as `'"'"'`. Anything else is rejected.
 */
export function parseShellToken(token: string): string | undefined {
  const bare = /^[A-Za-z0-9_./:=@+,-]+$/;
  if (bare.test(token)) return token;
  const quoted = parseQuotedToken(token);
  // The CLI never quotes a token that can stay bare.
  return quoted === undefined || bare.test(quoted) ? undefined : quoted;
}
function parseQuotedToken(token: string): string | undefined {
  let index = 0;
  let out = "";
  if (!token.startsWith("'")) return undefined;
  while (index < token.length) {
    if (token[index] !== "'") return undefined;
    const end = token.indexOf("'", index + 1);
    if (end < 0) return undefined;
    out += token.slice(index + 1, end);
    index = end + 1;
    if (index === token.length) break;
    if (token.startsWith(`"'"'`, index)) {
      out += "'";
      index += 3;
      continue;
    }
    return undefined;
  }
  return out;
}

/** Splits `exec <token> <flag>` where the token may be single-quoted with spaces. */
function splitExecLine(line: string): { command: string; rest: string } | undefined {
  if (!line.startsWith("exec ")) return undefined;
  const body = line.slice(5);
  if (!body.startsWith("'")) {
    const space = body.indexOf(" ");
    return space < 0 ? undefined : { command: body.slice(0, space), rest: body.slice(space + 1) };
  }
  let index = 0;
  while (index < body.length) {
    const end = body.indexOf("'", index + 1);
    if (end < 0) return undefined;
    index = end + 1;
    if (body.startsWith(`"'"'`, index)) {
      index += 3;
      continue;
    }
    break;
  }
  if (body[index] !== " ") return undefined;
  return { command: body.slice(0, index), rest: body.slice(index + 1) };
}

/** Exact wrapper bytes the CLI writes: three fixed header lines, then one exec line. */
export async function verifyClaudeWrapper(
  bytes: string,
  header: ReadonlyArray<string>,
  nativeHostArgs: ReadonlyArray<string>,
  executableRealpath: string,
  realpath: (path: string) => Promise<string>,
): Promise<boolean> {
  const lines = bytes.split("\n");
  // Header, the exec line, and the trailing newline's empty element.
  if (lines.length !== header.length + 2 || lines.at(-1) !== "") return false;
  for (const [index, line] of header.entries()) if (lines[index] !== line) return false;
  const exec = splitExecLine(lines[header.length]!);
  if (!exec || exec.rest !== nativeHostArgs.join(" ")) return false;
  const command = parseShellToken(exec.command);
  if (!command || !command.startsWith("/")) return false;
  try {
    return (await realpath(command)) === executableRealpath;
  } catch {
    return false;
  }
}

/** Provenance of the CLI's own Chrome MCP server, checked on every status read. */
export async function verifyClaudeChromeServer(
  status: ChromeServerStatus | undefined,
  expected: { readonly serverName: string; readonly mcpArgs: ReadonlyArray<string> },
  context: {
    readonly executableRealpath: string;
    readonly toolNames: ReadonlyArray<string>;
    readonly realpath: (path: string) => Promise<string>;
  },
): Promise<boolean> {
  if (!status || status.name !== expected.serverName || status.status !== "connected") return false;
  if (status.source !== "dynamic" && status.scope !== "dynamic") return false;
  if (status.config !== undefined) {
    const config = status.config as { type?: unknown; command?: unknown; args?: unknown };
    if (typeof config !== "object" || config === null) return false;
    if (config.type !== undefined && config.type !== "stdio") return false;
    if (typeof config.command !== "string") return false;
    try {
      if ((await context.realpath(config.command)) !== context.executableRealpath) return false;
    } catch {
      return false;
    }
    if (JSON.stringify(config.args) !== JSON.stringify(expected.mcpArgs)) return false;
  }
  if (status.tools !== undefined) {
    if (!Array.isArray(status.tools)) return false;
    const allowed = new Set(context.toolNames);
    for (const tool of status.tools) {
      const name = typeof tool === "string" ? tool : (tool as { name?: unknown } | null)?.name;
      if (typeof name !== "string" || !allowed.has(name)) return false;
    }
  }
  return true;
}

export function claudeChromeDescriptor(record: ClaudeChromeRecord): ChromeNativeHostDescriptor {
  const identity = record.identity;
  const expectedTarget = (providerHome: string) => join(providerHome, ...identity.wrapperPath);
  return {
    provider: "claude",
    recordId: record.id,
    registrationOwner: "provider-cli",
    hostNames: [identity.hostName],
    allowedOrigins: identity.allowedOrigins,
    browsers: record.browsers.map((browser) => browser.id),
    expectedTarget,
    locations: (_providerHome, userHome) =>
      dedupeLocations(
        record.browsers.map((browser) => ({
          browser: browser.id,
          hostName: identity.hostName,
          kind: "file" as const,
          path: join(userHome, ...browser.nativeMessagingPath, `${identity.hostName}.json`),
        })),
      ),
    verifyWrapper: (bytes, executableRealpath, realpath) =>
      verifyClaudeWrapper(
        bytes,
        identity.wrapperHeader,
        identity.nativeHostArgs,
        executableRealpath,
        realpath,
      ),
    verifyServer: (status, context) =>
      verifyClaudeChromeServer(
        status,
        { serverName: identity.mcpServerName, mcpArgs: identity.mcpArgs },
        context,
      ),
  };
}

/** Codex owns its registrations; F5 only inspects them, and the target is the plugin host. */
export function codexChromeDescriptor(
  record: CodexChromeRecord,
  target: (codexHome: string) => string,
): ChromeNativeHostDescriptor {
  return {
    provider: "codex",
    recordId: record.id,
    registrationOwner: "external",
    hostNames: [record.identity.hostName],
    allowedOrigins: record.identity.allowedOrigins,
    browsers: record.browsers.map((browser) => browser.id),
    expectedTarget: target,
    locations: (_home, userHome) =>
      dedupeLocations(
        record.browsers.map((browser) => ({
          browser: browser.id,
          hostName: record.identity.hostName,
          kind: "file" as const,
          path: join(userHome, ...browser.nativeMessagingPath, `${record.identity.hostName}.json`),
        })),
      ),
  };
}

/** Locations are deduplicated by absolute path; the first browser keeps the slot. */
export function dedupeLocations(
  locations: ReadonlyArray<ChromeNativeHostLocation>,
): ReadonlyArray<ChromeNativeHostLocation> {
  const seen = new Set<string>();
  return locations.filter((location) => {
    const key = location.kind === "file" ? location.path : `${location.view}:${location.key}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export type ChromeLaunchDecision =
  | { readonly kind: "off" | "unknown"; readonly detail?: string }
  | { readonly kind: "launch"; readonly targetPath: string }
  | {
      readonly kind: "needs-consent";
      readonly targetPath: string;
      readonly previousTargets: ReadonlyArray<string>;
    };

export interface AcceptedChromeSetup {
  readonly profileId: string;
  readonly providerInstanceId: string;
  readonly targetPath: string;
  /** The exact foreign snapshot the user accepted, by location. */
  readonly acceptedForeign: ReadonlyArray<{ readonly location: string; readonly sha256: string }>;
}

/**
 * Another F5 profile's registration is foreign. Consent is reusable only for the same
 * profile, provider instance and target, and only for the exact accepted foreign bytes.
 */
export function chromeLaunchDecision(input: {
  enabled: boolean;
  certified: boolean;
  descriptor: ChromeNativeHostDescriptor;
  providerHome: string;
  profileId: string;
  providerInstanceId: string;
  registrations: ReadonlyArray<ChromeNativeHostRegistration>;
  accepted?: AcceptedChromeSetup;
}): ChromeLaunchDecision {
  if (!input.enabled || !input.certified) return { kind: "off" };
  const bad = input.registrations.find(
    (entry) => entry.state === "unreadable" || entry.state === "malformed",
  );
  if (bad) return { kind: "unknown", detail: `Chrome setup unreadable: ${bad.location}` };
  const targetPath = input.descriptor.expectedTarget(input.providerHome);
  const foreign = input.registrations.filter(
    (entry) => !entry.shadowed && entry.state === "ok" && entry.targetPath !== targetPath,
  );
  const accepted =
    input.accepted !== undefined &&
    input.accepted.profileId === input.profileId &&
    input.accepted.providerInstanceId === input.providerInstanceId &&
    input.accepted.targetPath === targetPath &&
    foreign.every((entry) =>
      input.accepted!.acceptedForeign.some(
        (original) => original.location === entry.location && original.sha256 === entry.sha256,
      ),
    );
  return !foreign.length || accepted
    ? { kind: "launch", targetPath }
    : {
        kind: "needs-consent",
        targetPath,
        previousTargets: [...new Set(foreign.map((entry) => entry.targetPath!))],
      };
}

export function parseNativeHostManifest(
  browser: string,
  location: string,
  bytes: string | null,
): ChromeNativeHostRegistration {
  if (bytes === null) return { browser, location, state: "absent" };
  const digest = sha256(bytes);
  try {
    const value = JSON.parse(bytes) as {
      path?: unknown;
      name?: unknown;
      type?: unknown;
      allowed_origins?: unknown;
    };
    if (
      typeof value.path !== "string" ||
      !value.path ||
      typeof value.name !== "string" ||
      value.type !== "stdio" ||
      !Array.isArray(value.allowed_origins) ||
      !value.allowed_origins.every((origin) => typeof origin === "string")
    )
      return { browser, location, state: "malformed", sha256: digest };
    return {
      browser,
      location,
      state: "ok",
      bytes,
      sha256: digest,
      targetPath: value.path,
      allowedOrigins: value.allowed_origins as string[],
    };
  } catch {
    return { browser, location, state: "malformed", sha256: digest };
  }
}

/** Parses reg query's default manifest path without assuming one registry view. */
export function parseChromeRegistryQuery(stdout: string): string | null {
  const line = stdout
    .split(/\r?\n/)
    .find((entry) => /^\s*(?:\(Default\)|<NO NAME>)\s+REG_SZ\s+/i.test(entry));
  return line?.replace(/^\s*(?:\(Default\)|<NO NAME>)\s+REG_SZ\s+/i, "").trim() || null;
}

export function effectiveChromeRegistrations(
  entries: ReadonlyArray<ChromeNativeHostRegistration>,
): ReadonlyArray<ChromeNativeHostRegistration> {
  const seen = new Set<string>();
  // Caller supplies Chrome lookup order: user before machine, each certified view.
  return entries.map((entry) => {
    const identity = `${entry.browser}\0${entry.hostName ?? ""}`;
    const shadowed = seen.has(identity);
    if (entry.state !== "absent") seen.add(identity);
    return { ...entry, shadowed };
  });
}
