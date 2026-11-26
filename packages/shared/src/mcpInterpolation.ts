import type { McpProjectServersConfig } from "@t3tools/contracts";

type ServerDefinition = McpProjectServersConfig[string];
type Environment = Readonly<Record<string, string | undefined>>;

/** `${env:NAME}` or `${env:NAME:-default}`; the default may be empty and may not contain `}`. */
const ENV_REFERENCE = /\$\{env:([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/gu;
/** Claude, Cursor and similar clients write `${NAME}` or `${NAME:-default}`. */
const BARE_ENV_REFERENCE = /\$\{([A-Za-z_][A-Za-z0-9_]*)(:-[^}]*)?\}/gu;
/** Any other `${...}` that is neither interpolated nor an F5 secret placeholder. */
const UNKNOWN_REFERENCE = /\$\{(?!env:[A-Za-z_][A-Za-z0-9_]*(?::-[^}]*)?\})(?!f5-secret:)[^}]*\}/u;

export const MCP_ENV_REFERENCE_SYNTAX = "${env:NAME} or ${env:NAME:-default}";

export interface McpInterpolationResult {
  readonly value: string;
  /** Variables that were unset and had no default. */
  readonly missing: ReadonlyArray<string>;
}

/** Expands `${env:…}` references in one value; anything else stays literal. */
export function interpolateMcpValue(
  value: string,
  environment: Environment,
): McpInterpolationResult {
  const missing: string[] = [];
  const expanded = value.replace(ENV_REFERENCE, (_match, name: string, fallback?: string) => {
    const resolved = environment[name];
    if (resolved !== undefined && resolved !== "") return resolved;
    if (fallback !== undefined) return fallback;
    if (!missing.includes(name)) missing.push(name);
    return "";
  });
  return { value: expanded, missing };
}

/** The variable names a value references with `${env:…}`. */
export function mcpEnvReferenceNames(value: string): string[] {
  return [...new Set(Array.from(value.matchAll(ENV_REFERENCE), (match) => match[1]!))];
}

export function hasMcpEnvReference(value: string | undefined): boolean {
  if (value === undefined) return false;
  ENV_REFERENCE.lastIndex = 0;
  const found = ENV_REFERENCE.test(value);
  ENV_REFERENCE.lastIndex = 0;
  return found;
}

/** VS Code's predefined variables, which are not environment variables. */
const EDITOR_VARIABLES = new Set([
  "cwd",
  "defaultBuildTask",
  "execPath",
  "file",
  "fileBasename",
  "fileBasenameNoExtension",
  "fileDirname",
  "fileDirnameBasename",
  "fileExtname",
  "fileWorkspaceFolder",
  "lineNumber",
  "pathSeparator",
  "relativeFile",
  "relativeFileDirname",
  "selectedText",
  "userHome",
  "workspaceFolder",
  "workspaceFolderBasename",
  "workspaceRoot",
]);

/** Rewrites Claude-style `${NAME}` references to F5's `${env:NAME}` form. */
export function convertBareEnvReferences(value: string): string {
  return value.replace(BARE_ENV_REFERENCE, (match, name: string, fallback?: string) =>
    EDITOR_VARIABLES.has(name) ? match : `\${env:${name}${fallback ?? ""}}`,
  );
}

/** True when a value holds a `${…}` that F5 passes literally. */
export function hasUnknownMcpReference(value: string): boolean {
  return UNKNOWN_REFERENCE.test(value);
}

/** The interpolated fields of a definition, as `[field, value]` pairs. */
export function mcpInterpolatedFields(server: ServerDefinition): Array<readonly [string, string]> {
  const fields: Array<readonly [string, string]> = [];
  if (server.type === "stdio") {
    fields.push(["command", server.command]);
    server.args?.forEach((value, index) => fields.push([`args.${index}`, value]));
    for (const [key, value] of Object.entries(server.env ?? {})) fields.push([`env.${key}`, value]);
    if (server.cwd !== undefined) fields.push(["cwd", server.cwd]);
  } else {
    fields.push(["url", server.url]);
    for (const [key, value] of Object.entries(server.headers ?? {}))
      fields.push([`headers.${key}`, value]);
  }
  return fields;
}

/** Maps every interpolated field of a definition through `transform`. */
export function mapMcpInterpolatedFields(
  server: ServerDefinition,
  transform: (value: string) => string,
): ServerDefinition {
  const record = (values: Readonly<Record<string, string>> | undefined) =>
    values === undefined
      ? undefined
      : Object.fromEntries(Object.entries(values).map(([key, value]) => [key, transform(value)]));
  if (server.type === "stdio") {
    const env = record(server.env);
    return {
      ...server,
      command: transform(server.command),
      ...(server.args ? { args: server.args.map(transform) } : {}),
      ...(env ? { env } : {}),
      ...(server.cwd !== undefined ? { cwd: transform(server.cwd) } : {}),
    };
  }
  const headers = record(server.headers);
  return { ...server, url: transform(server.url), ...(headers ? { headers } : {}) };
}

export interface McpInterpolationSkip {
  readonly name: string;
  readonly variables: ReadonlyArray<string>;
}

export function describeMcpInterpolationSkip(skip: McpInterpolationSkip): string {
  const list = skip.variables.join(", ");
  return skip.variables.length === 1
    ? `needs the environment variable ${list}, which is not set`
    : `needs the environment variables ${list}, which are not set`;
}

/**
 * Settings issues for servers whose `${env:…}` references are unset in F5's own
 * environment. Accounts can still set them, so this is a warning, not an error.
 */
export function readMcpEnvironmentIssues(
  servers: McpProjectServersConfig | null | undefined,
  environment: Environment,
): Array<{
  readonly kind: "compatibility";
  readonly serverName: string;
  readonly message: string;
}> {
  return interpolateMcpServers(servers, environment).skipped.map((skip) => ({
    kind: "compatibility" as const,
    serverName: skip.name,
    message: `${skip.name} ${describeMcpInterpolationSkip(skip)} in F5's environment. It starts only for provider accounts that set ${skip.variables.length === 1 ? "it" : "them"}.`,
  }));
}

/**
 * Resolves `${env:…}` references from an account environment. A server that
 * references an unset variable with no default is left out and reported, so it
 * never starts with a half-built command or URL.
 */
export function interpolateMcpServers(
  servers: McpProjectServersConfig | null | undefined,
  environment: Environment,
): {
  readonly servers: McpProjectServersConfig;
  readonly skipped: ReadonlyArray<McpInterpolationSkip>;
} {
  // A server named `__proto__` must stay a key, not replace the prototype.
  const resolved: Record<string, ServerDefinition> = Object.create(null);
  const skipped: McpInterpolationSkip[] = [];
  for (const [name, server] of Object.entries(servers ?? {})) {
    if (!mcpInterpolatedFields(server).some(([, value]) => hasMcpEnvReference(value))) {
      resolved[name] = server;
      continue;
    }
    const missing: string[] = [];
    const next = mapMcpInterpolatedFields(server, (value) => {
      const result = interpolateMcpValue(value, environment);
      for (const variable of result.missing)
        if (!missing.includes(variable)) missing.push(variable);
      return result.value;
    });
    // A disabled server never starts, so its unset variables do not matter.
    if (missing.length > 0 && server.enabled !== false) skipped.push({ name, variables: missing });
    else resolved[name] = next;
  }
  return { servers: resolved as McpProjectServersConfig, skipped };
}
