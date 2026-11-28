/**
 * The MCP catalog: searches the official MCP Registry when the user opens the
 * Catalog or searches it. There are no background calls. Pages are cached for an
 * hour. Entries are normalized to what F5 can run: remote servers over HTTP or SSE,
 * and npm, PyPI and container packages over stdio.
 */
import type {
  McpCatalogArgument,
  McpCatalogEntry,
  McpCatalogInput,
  McpCatalogPackage,
  McpCatalogRemote,
  McpSearchCatalogRequest,
  McpSearchCatalogResult,
} from "@t3tools/contracts";

export const MCP_REGISTRY_URL = "https://registry.modelcontextprotocol.io/v0.1/servers";
export const MCP_CATALOG_CACHE_MS = 60 * 60 * 1000;
const PAGE_SIZE = 30;
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_CACHED_PAGES = 64;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_TEXT = 2_000;

export interface McpCatalog {
  readonly search: (
    request: McpSearchCatalogRequest,
    signal?: AbortSignal,
  ) => Promise<McpSearchCatalogResult>;
}

export interface McpCatalogOptions {
  readonly fetch?: typeof globalThis.fetch;
  readonly now?: () => number;
  readonly registryUrl?: string;
}

type Json = Record<string, unknown>;

function record(value: unknown): Json | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : undefined;
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function text(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, MAX_TEXT) : undefined;
}

function optional<K extends string>(key: K, value: string | undefined) {
  return (value === undefined ? {} : { [key]: value }) as Partial<Record<K, string>>;
}

function toInput(value: unknown): McpCatalogInput | undefined {
  const input = record(value);
  const name = text(input?.name);
  if (!input || !name) return undefined;
  return {
    name,
    ...optional("description", text(input.description)),
    required: input.isRequired === true,
    secret: input.isSecret === true,
    ...optional("value", text(input.value)),
    ...optional("default", text(input.default)),
  };
}

function toArgument(value: unknown): McpCatalogArgument | undefined {
  const argument = record(value);
  if (!argument) return undefined;
  const type =
    argument.type === "named" ? "named" : argument.type === "positional" ? "positional" : undefined;
  if (!type) return undefined;
  const name = text(argument.name);
  const argumentValue = text(argument.value);
  if (type === "named" && !name) return undefined;
  if (
    type === "positional" &&
    !argumentValue &&
    !text(argument.valueHint) &&
    !text(argument.default)
  )
    return undefined;
  return {
    type,
    ...optional("name", name),
    ...optional("value", argumentValue),
    ...optional("default", text(argument.default)),
    ...optional("valueHint", text(argument.valueHint)),
    ...optional("description", text(argument.description)),
    required: argument.isRequired === true,
    flag: type === "named" && argument.format === "boolean" && !argumentValue,
  };
}

/** An http(s) URL, or undefined. */
function webUrl(value: unknown): string | undefined {
  const url = text(value);
  if (!url) return undefined;
  try {
    const { protocol } = new URL(url);
    return protocol === "http:" || protocol === "https:" ? url : undefined;
  } catch {
    return undefined;
  }
}

function toRemote(value: unknown): McpCatalogRemote | undefined {
  const remote = record(value);
  const url = text(remote?.url);
  if (!remote || !url || !/^https?:\/\//i.test(url)) return undefined;
  const type =
    remote.type === "streamable-http" ? "http" : remote.type === "sse" ? "sse" : undefined;
  if (!type) return undefined;
  return { type, url, headers: list(remote.headers).flatMap((header) => toInput(header) ?? []) };
}

const REGISTRY_TYPES = new Set(["npm", "pypi", "oci"]);

function toPackage(value: unknown): McpCatalogPackage | undefined {
  const pkg = record(value);
  const identifier = text(pkg?.identifier);
  const registryType = text(pkg?.registryType);
  // Only stdio packages run as-is; a package serving HTTP needs its own setup.
  const transport = record(pkg?.transport)?.type;
  if (!pkg || !identifier || !registryType || !REGISTRY_TYPES.has(registryType)) return undefined;
  if (transport !== undefined && transport !== "stdio") return undefined;
  // A leading dash would make the identifier an option of npx, uvx or docker.
  if (identifier.startsWith("-")) return undefined;
  // `fileSha256` is not read: npx, uvx and docker fetch these packages from their own
  // registries, which check integrity; F5 never downloads the file it would describe.
  // MCPB packages, where the hash is the only check, are not offered.
  return {
    registryType: registryType as McpCatalogPackage["registryType"],
    identifier,
    ...optional("version", text(pkg.version)),
    environmentVariables: list(pkg.environmentVariables).flatMap((entry) => toInput(entry) ?? []),
    packageArguments: list(pkg.packageArguments).flatMap((entry) => toArgument(entry) ?? []),
    runtimeArguments: list(pkg.runtimeArguments).flatMap((entry) => toArgument(entry) ?? []),
  };
}

/** One registry listing, or undefined when it is deleted or offers nothing F5 can run. */
export function toCatalogEntry(value: unknown): McpCatalogEntry | undefined {
  const item = record(value);
  const server = record(item?.server);
  const name = text(server?.name);
  if (!server || !name) return undefined;
  const official = record(record(item?._meta)?.["io.modelcontextprotocol.registry/official"]);
  if (official?.status === "deleted") return undefined;
  const remotes = list(server.remotes).flatMap((remote) => toRemote(remote) ?? []);
  const packages = list(server.packages).flatMap((pkg) => toPackage(pkg) ?? []);
  if (remotes.length === 0 && packages.length === 0) return undefined;
  return {
    name,
    ...optional("title", text(server.title)),
    ...optional("description", text(server.description)),
    ...optional("version", text(server.version)),
    // Shown as links: anything but http(s) could hand a click to another application.
    ...optional("websiteUrl", webUrl(server.websiteUrl)),
    ...optional("repositoryUrl", webUrl(record(server.repository)?.url)),
    remotes,
    packages,
  };
}

/** The body as text, refused as soon as it passes `maxBytes` (declared or streamed). */
async function readCappedText(response: Response, maxBytes: number): Promise<string> {
  const tooLarge = () => new Error("The MCP Registry's answer was too large.");
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => {});
    throw tooLarge();
  }
  if (!response.body) {
    const body = await response.text();
    if (Buffer.byteLength(body) > maxBytes) throw tooLarge();
    return body;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw tooLarge();
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export function makeMcpCatalog(options: McpCatalogOptions = {}): McpCatalog {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const now = options.now ?? Date.now;
  const registryUrl = options.registryUrl ?? MCP_REGISTRY_URL;
  const cache = new Map<string, { readonly at: number; readonly result: McpSearchCatalogResult }>();

  const search = async (
    request: McpSearchCatalogRequest,
    signal?: AbortSignal,
  ): Promise<McpSearchCatalogResult> => {
    const query = request.query?.trim() ?? "";
    const key = `${query}\0${request.cursor ?? ""}`;
    const cached = cache.get(key);
    if (cached && now() - cached.at < MCP_CATALOG_CACHE_MS) return cached.result;

    const url = new URL(registryUrl);
    url.searchParams.set("limit", String(PAGE_SIZE));
    url.searchParams.set("version", "latest");
    if (query) url.searchParams.set("search", query);
    if (request.cursor) url.searchParams.set("cursor", request.cursor);
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    const response = await fetchImpl(url, {
      headers: { accept: "application/json", "user-agent": "F5-MCP-Catalog" },
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    if (!response.ok)
      throw new Error(`The MCP Registry answered ${response.status}. Try again later.`);
    const body = await readCappedText(response, MAX_RESPONSE_BYTES);
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      throw new Error("The MCP Registry's answer could not be read.");
    }
    const data = record(parsed);
    const nextCursor = text(record(data?.metadata)?.nextCursor);
    const result: McpSearchCatalogResult = {
      entries: list(data?.servers).flatMap((item) => toCatalogEntry(item) ?? []),
      ...(nextCursor ? { nextCursor } : {}),
    };
    cache.delete(key);
    cache.set(key, { at: now(), result });
    // Oldest first: Map keeps insertion order, and hits are re-inserted above.
    while (cache.size > MAX_CACHED_PAGES) cache.delete(cache.keys().next().value!);
    return result;
  };

  return { search };
}
