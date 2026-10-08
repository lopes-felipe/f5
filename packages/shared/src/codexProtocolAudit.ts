import {
  CODEX_CLIENT_REQUEST_METHODS,
  CODEX_DECODED_RESPONSE_FIELDS,
  CODEX_NOTIFICATION_METHODS,
  CODEX_SERVER_REQUEST_METHODS,
  CODEX_THREAD_ITEM_TYPES,
} from "./codexProtocolManifest";
import { parseCodexCliVersion } from "./codexCliVersion";

export interface CodexProtocolSurface {
  readonly notifications: ReadonlyArray<string>;
  readonly requests: ReadonlyArray<string>;
  readonly items: ReadonlyArray<string>;
  /** Methods in the CLI's `ClientRequest` union. Omit to skip the client-request check. */
  readonly clientRequests?: ReadonlyArray<string>;
}

export interface CodexClientRequestReport {
  /** Groups where the CLI supports none of the methods F5 can send. */
  readonly unsupported: ReadonlyArray<string>;
  /** Groups served only by a fallback because the preferred method is missing. */
  readonly usingFallback: ReadonlyArray<string>;
}

export interface CodexProtocolSurfaceDrift {
  readonly added: ReadonlyArray<string>;
  readonly removed: ReadonlyArray<string>;
}

export interface CodexProtocolDriftReport {
  readonly notifications: CodexProtocolSurfaceDrift;
  readonly requests: CodexProtocolSurfaceDrift;
  readonly items: CodexProtocolSurfaceDrift;
  readonly clientRequests: CodexClientRequestReport;
  readonly hasDrift: boolean;
}

export function checkCodexClientRequests(
  actual: ReadonlyArray<string>,
  groups: ReadonlyArray<ReadonlyArray<string>> = CODEX_CLIENT_REQUEST_METHODS,
): CodexClientRequestReport {
  const available = new Set(actual);
  const unsupported: string[] = [];
  const usingFallback: string[] = [];
  for (const group of groups) {
    const served = group.find((method) => available.has(method));
    if (served === undefined) unsupported.push(group.join(" | "));
    else if (served !== group[0]) usingFallback.push(`${group[0]} -> ${served}`);
  }
  return { unsupported, usingFallback };
}

export function isExpectedCodexProtocolVersion(
  installedVersionOutput: string,
  expectedVersion: string,
): boolean {
  return parseCodexCliVersion(installedVersionOutput) === expectedVersion;
}

function sortedUnique(values: Iterable<string>): string[] {
  return [...new Set(values)].toSorted((left, right) => left.localeCompare(right));
}

export function extractCodexTaggedUnionValues(source: string, tag: "method" | "type"): string[] {
  const pattern = new RegExp(`"${tag}"\\s*:\\s*"([^"]+)"`, "g");
  return sortedUnique(
    Array.from(source.matchAll(pattern), (match) => match[1] ?? "").filter(Boolean),
  );
}

function surfaceDrift(
  actual: ReadonlyArray<string>,
  expected: ReadonlyArray<string>,
): CodexProtocolSurfaceDrift {
  const actualSet = new Set(actual);
  const expectedSet = new Set(expected);
  return {
    added: sortedUnique(actual.filter((value) => !expectedSet.has(value))),
    removed: sortedUnique(expected.filter((value) => !actualSet.has(value))),
  };
}

export function diffCodexProtocolSurface(actual: CodexProtocolSurface): CodexProtocolDriftReport {
  const notifications = surfaceDrift(actual.notifications, CODEX_NOTIFICATION_METHODS);
  const requests = surfaceDrift(actual.requests, CODEX_SERVER_REQUEST_METHODS);
  const items = surfaceDrift(actual.items, CODEX_THREAD_ITEM_TYPES);
  const clientRequests =
    actual.clientRequests === undefined
      ? { unsupported: [], usingFallback: [] }
      : checkCodexClientRequests(actual.clientRequests);
  return {
    notifications,
    requests,
    items,
    clientRequests,
    hasDrift:
      clientRequests.unsupported.length > 0 ||
      [notifications, requests, items].some(
        (drift) => drift.added.length > 0 || drift.removed.length > 0,
      ),
  };
}

type JsonSchemaNode = { readonly [key: string]: unknown };

function asSchemaNode(value: unknown): JsonSchemaNode | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonSchemaNode)
    : undefined;
}

/** Expand `$ref`, `allOf`, `anyOf` and `oneOf` into the concrete alternatives. */
function expandSchemaNode(
  root: JsonSchemaNode,
  node: JsonSchemaNode,
  seen: Set<JsonSchemaNode> = new Set(),
): JsonSchemaNode[] {
  if (seen.has(node)) return [];
  seen.add(node);
  const expanded: JsonSchemaNode[] = [node];
  const ref = node.$ref;
  if (typeof ref === "string" && ref.startsWith("#/")) {
    let target: unknown = root;
    for (const segment of ref.slice(2).split("/")) target = asSchemaNode(target)?.[segment];
    const resolved = asSchemaNode(target);
    if (resolved) expanded.push(...expandSchemaNode(root, resolved, seen));
  }
  for (const combinator of ["allOf", "anyOf", "oneOf"] as const) {
    const branches = node[combinator];
    if (!Array.isArray(branches)) continue;
    for (const branch of branches) {
      const branchNode = asSchemaNode(branch);
      if (branchNode) expanded.push(...expandSchemaNode(root, branchNode, seen));
    }
  }
  return expanded;
}

/**
 * True when every step of `fieldPath` exists in at least one alternative of
 * the JSON schema. `a.b[]` steps into the array items of `b`.
 */
export function codexJsonSchemaHasField(root: unknown, fieldPath: string): boolean {
  const rootNode = asSchemaNode(root);
  if (!rootNode) return false;
  let current: JsonSchemaNode[] = [rootNode];
  for (const rawSegment of fieldPath.split(".")) {
    const isArray = rawSegment.endsWith("[]");
    const name = isArray ? rawSegment.slice(0, -2) : rawSegment;
    const next: JsonSchemaNode[] = [];
    for (const node of current.flatMap((candidate) => expandSchemaNode(rootNode, candidate))) {
      const property = asSchemaNode(asSchemaNode(node.properties)?.[name]);
      if (property) next.push(property);
    }
    if (next.length === 0) return false;
    if (!isArray) {
      current = next;
      continue;
    }
    const items: JsonSchemaNode[] = [];
    for (const node of next.flatMap((candidate) => expandSchemaNode(rootNode, candidate))) {
      const itemNode = asSchemaNode(node.items);
      if (itemNode) items.push(itemNode);
    }
    if (items.length === 0) return false;
    current = items;
  }
  return true;
}

export interface CodexResponseFieldReport {
  /** `<method> <schema file>: <field path>` entries the generated schema lacks. */
  readonly missingFields: ReadonlyArray<string>;
  /** Schemas absent from the bundle although the CLI offers their method. */
  readonly missingSchemas: ReadonlyArray<string>;
  /** Methods skipped because the CLI does not offer them. */
  readonly skippedMethods: ReadonlyArray<string>;
}

export type CodexDecodedResponseFields = Readonly<
  Record<string, { readonly schema: string; readonly fields: ReadonlyArray<string> }>
>;

export function auditCodexResponseFields(
  readSchema: (schemaFile: string) => unknown,
  availableMethods?: ReadonlySet<string>,
  decoded: CodexDecodedResponseFields = CODEX_DECODED_RESPONSE_FIELDS,
): CodexResponseFieldReport {
  const missingFields: string[] = [];
  const missingSchemas: string[] = [];
  const skippedMethods: string[] = [];
  for (const [method, { schema: schemaFile, fields }] of Object.entries(decoded)) {
    if (availableMethods !== undefined && !availableMethods.has(method)) {
      skippedMethods.push(method);
      continue;
    }
    const schema = readSchema(schemaFile);
    if (schema === undefined) {
      missingSchemas.push(`${method} ${schemaFile}`);
      continue;
    }
    for (const fieldPath of fields) {
      if (!codexJsonSchemaHasField(schema, fieldPath)) {
        missingFields.push(`${method} ${schemaFile}: ${fieldPath}`);
      }
    }
  }
  return { missingFields, missingSchemas, skippedMethods };
}
