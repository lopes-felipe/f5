/**
 * Maps an MCP Registry entry to a server definition for the Add form. The result
 * is a starting point for review: nothing is saved or run from here.
 *
 * - Remote servers map to `http` or `sse` with the headers they declare.
 * - npm packages run with `npx -y <package>@<version>`, PyPI packages with
 *   `uvx <package>==<version>`, container images with `docker run -i --rm`.
 * - Secret environment variables and headers are left empty and listed in
 *   `secretKeys`, so the form asks for a stored secret before saving.
 */
import {
  MCP_SERVER_DESCRIPTION_MAX_LENGTH,
  type McpCatalogArgument,
  type McpCatalogEntry,
  type McpCatalogInput,
  type McpCatalogPackage,
  type McpServerDefinition,
} from "@t3tools/contracts";

import { sanitizeMcpServerName } from "./mcpServerName";

export type McpCatalogChoice =
  | { readonly kind: "remote"; readonly index: number }
  | { readonly kind: "package"; readonly index: number };

export interface McpCatalogOption {
  readonly choice: McpCatalogChoice;
  readonly label: string;
}

export interface McpCatalogDraft {
  readonly name: string;
  readonly server: McpServerDefinition;
  /** Environment variables or headers that need a stored secret before saving. */
  readonly secretKeys: ReadonlyArray<string>;
  /** Values the entry needs that F5 could not fill, for the user to complete. */
  readonly needsInput: ReadonlyArray<string>;
}

const PACKAGE_LABELS: Record<McpCatalogPackage["registryType"], string> = {
  npm: "npm package",
  pypi: "PyPI package",
  oci: "Container image",
};

/** The ways an entry can be added, remote servers first. */
export function mcpCatalogOptions(entry: McpCatalogEntry): McpCatalogOption[] {
  return [
    ...entry.remotes.map((remote, index) => ({
      choice: { kind: "remote" as const, index },
      label: remote.type === "sse" ? "Remote (SSE)" : "Remote (HTTP)",
    })),
    ...entry.packages.map((pkg, index) => ({
      choice: { kind: "package" as const, index },
      label: PACKAGE_LABELS[pkg.registryType],
    })),
  ];
}

/** A short server name from a registry name such as `io.github.owner/server-name`. */
export function mcpCatalogServerName(entry: McpCatalogEntry): string {
  const last = entry.name.split("/").pop() || entry.name;
  return sanitizeMcpServerName(last.replace(/^(mcp[-_]server[-_]|server[-_])/i, "") || last);
}

function describe(entry: McpCatalogEntry): string | undefined {
  const text = entry.description ?? entry.title;
  return text ? text.slice(0, MCP_SERVER_DESCRIPTION_MAX_LENGTH) : undefined;
}

/** Fills `{placeholder}` values only when the input is fixed and holds none. */
function inputValue(input: McpCatalogInput): string | undefined {
  const value = input.value ?? input.default;
  return value !== undefined && !/\{[^}]+\}/.test(value) ? value : undefined;
}

function collectInputs(
  inputs: ReadonlyArray<McpCatalogInput>,
  secretKeys: string[],
  needsInput: string[],
): Record<string, string> | undefined {
  const values: Record<string, string> = {};
  for (const input of inputs) {
    if (input.secret) {
      // An optional secret stays out until the user wants it.
      if (!input.required) continue;
      values[input.name] = "";
      secretKeys.push(input.name);
      continue;
    }
    const value = inputValue(input);
    if (value !== undefined) values[input.name] = value;
    else if (input.required) {
      values[input.name] = "";
      needsInput.push(input.name);
    }
  }
  return Object.keys(values).length > 0 ? values : undefined;
}

function argumentWords(argument: McpCatalogArgument, needsInput: string[]): string[] {
  const value = argument.value ?? argument.default;
  if (argument.type === "positional") {
    if (value !== undefined && !/\{[^}]+\}/.test(value)) return [value];
    if (!argument.required) return [];
    const hint = argument.valueHint ?? "value";
    needsInput.push(`argument <${hint}>`);
    return [`<${hint}>`];
  }
  const name = argument.name!;
  const flag = name.startsWith("-") ? name : `--${name}`;
  if (argument.flag) return argument.required ? [flag] : [];
  if (value !== undefined && !/\{[^}]+\}/.test(value)) return [flag, value];
  if (!argument.required) return [];
  const hint = argument.valueHint ?? name.replace(/^-+/, "");
  needsInput.push(`${flag} <${hint}>`);
  return [flag, `<${hint}>`];
}

const BASE_RUNTIME_WORDS: Record<McpCatalogPackage["registryType"], ReadonlyArray<string>> = {
  npm: ["-y"],
  pypi: [],
  oci: ["run", "-i", "--rm"],
};

function packageServer(
  pkg: McpCatalogPackage,
  description: string | undefined,
  secretKeys: string[],
  needsInput: string[],
): McpServerDefinition {
  const env = collectInputs(pkg.environmentVariables, secretKeys, needsInput);
  const base = BASE_RUNTIME_WORDS[pkg.registryType];
  const runtime = pkg.runtimeArguments
    .flatMap((argument) => argumentWords(argument, needsInput))
    .filter((word) => !base.includes(word));
  // A container sees only the variables passed to it.
  const containerEnv =
    pkg.registryType === "oci" ? Object.keys(env ?? {}).flatMap((name) => ["-e", name]) : [];
  const target =
    pkg.registryType === "npm"
      ? pkg.version
        ? `${pkg.identifier}@${pkg.version}`
        : pkg.identifier
      : pkg.registryType === "pypi"
        ? pkg.version
          ? `${pkg.identifier}==${pkg.version}`
          : pkg.identifier
        : pkg.identifier;
  const args = [
    ...base,
    ...runtime,
    ...containerEnv,
    target,
    ...pkg.packageArguments.flatMap((argument) => argumentWords(argument, needsInput)),
  ];
  const command =
    pkg.registryType === "npm" ? "npx" : pkg.registryType === "pypi" ? "uvx" : "docker";
  return {
    type: "stdio",
    command,
    args,
    ...(env ? { env } : {}),
    ...(description ? { description } : {}),
  } as McpServerDefinition;
}

export function mcpCatalogDraft(entry: McpCatalogEntry, choice: McpCatalogChoice): McpCatalogDraft {
  const secretKeys: string[] = [];
  const needsInput: string[] = [];
  const description = describe(entry);
  let server: McpServerDefinition;
  if (choice.kind === "remote") {
    const remote = entry.remotes[choice.index];
    if (!remote) throw new Error("That remote is no longer listed for this server.");
    if (/\{[^}]+\}/.test(remote.url)) needsInput.push("the URL's {placeholders}");
    const headers = collectInputs(remote.headers, secretKeys, needsInput);
    server = {
      type: remote.type,
      url: remote.url,
      ...(headers ? { headers } : {}),
      ...(description ? { description } : {}),
    } as McpServerDefinition;
  } else {
    const pkg = entry.packages[choice.index];
    if (!pkg) throw new Error("That package is no longer listed for this server.");
    server = packageServer(pkg, description, secretKeys, needsInput);
  }
  return { name: mcpCatalogServerName(entry), server, secretKeys, needsInput };
}
