import {
  CODEX_CLIENT_REQUEST_METHODS,
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
