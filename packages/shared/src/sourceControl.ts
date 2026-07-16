import type { ChangeRequest, SourceControlProviderKind } from "@t3tools/contracts";

export interface ParsedSourceControlRemote {
  readonly kind: SourceControlProviderKind;
  readonly host: string | null;
  readonly owner: string | null;
  readonly repository: string | null;
  readonly webUrl: string | null;
}

function stripGitSuffix(value: string): string {
  return value.replace(/\.git$/i, "").replace(/\/+$/g, "");
}

function providerKindFromHost(host: string): SourceControlProviderKind {
  const normalized = host.toLowerCase();
  const labels = normalized.split(".").filter(Boolean);
  if (normalized === "github.com") return "github";
  if (normalized === "gitlab.com" || labels.includes("gitlab")) return "gitlab";
  if (normalized === "bitbucket.org") return "bitbucket";
  if (
    normalized === "dev.azure.com" ||
    normalized.endsWith(".dev.azure.com") ||
    normalized === "ssh.dev.azure.com"
  ) {
    return "azure-devops";
  }
  return "unknown";
}

function parsePathParts(pathname: string): Pick<ParsedSourceControlRemote, "owner" | "repository"> {
  const parts = stripGitSuffix(pathname)
    .split("/")
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length < 2) {
    return { owner: null, repository: null };
  }
  return {
    owner: parts.slice(0, -1).join("/"),
    repository: parts.at(-1) ?? null,
  };
}

function parseAzurePathParts(
  pathname: string,
): Pick<ParsedSourceControlRemote, "owner" | "repository"> {
  const parts = stripGitSuffix(pathname)
    .split("/")
    .map((part) => part.trim())
    .filter(Boolean);
  const gitIndex = parts.findIndex((part) => part.toLowerCase() === "_git");
  if (gitIndex >= 2 && parts[gitIndex + 1]) {
    return {
      owner: `${parts[0]}/${parts[1]}`,
      repository: parts[gitIndex + 1] ?? null,
    };
  }

  const sshParts = parts[0]?.toLowerCase() === "v3" ? parts.slice(1) : parts;
  if (sshParts.length >= 3) {
    const [organization, project, repository] = sshParts;
    return {
      owner: organization && project ? `${organization}/${project}` : null,
      repository: repository ?? null,
    };
  }

  return parsePathParts(pathname);
}

function webUrlFromParts(input: {
  readonly kind: SourceControlProviderKind;
  readonly host: string;
  readonly owner: string | null;
  readonly repository: string | null;
}): string | null {
  if (!input.owner || !input.repository) return null;
  if (input.kind === "azure-devops") {
    const host = input.host === "ssh.dev.azure.com" ? "dev.azure.com" : input.host;
    return `https://${host}/${input.owner}/_git/${input.repository}`;
  }
  return `https://${input.host}/${input.owner}/${input.repository}`;
}

function parseRemoteParts(input: {
  readonly host: string;
  readonly pathname: string;
}): Pick<ParsedSourceControlRemote, "kind" | "owner" | "repository" | "webUrl"> {
  const kind = providerKindFromHost(input.host);
  const { owner, repository } =
    kind === "azure-devops" ? parseAzurePathParts(input.pathname) : parsePathParts(input.pathname);
  return {
    kind,
    owner,
    repository,
    webUrl: webUrlFromParts({ kind, host: input.host, owner, repository }),
  };
}

export function parseSourceControlRemoteUrl(
  url: string | null | undefined,
): ParsedSourceControlRemote {
  const raw = url?.trim();
  if (!raw) {
    return { kind: "unknown", host: null, owner: null, repository: null, webUrl: null };
  }

  const sshMatch = /^git@([^:]+):(.+)$/.exec(raw);
  if (sshMatch) {
    const host = sshMatch[1]!.trim();
    const parsed = parseRemoteParts({ host, pathname: sshMatch[2] ?? "" });
    return {
      kind: parsed.kind,
      host,
      owner: parsed.owner,
      repository: parsed.repository,
      webUrl: parsed.webUrl,
    };
  }

  const azureSshMatch = /^ssh:\/\/[^@]+@([^/]+)\/(?:v3\/)?(.+)$/.exec(raw);
  if (azureSshMatch) {
    const host = azureSshMatch[1]!.trim();
    const parsed = parseRemoteParts({ host, pathname: azureSshMatch[2] ?? "" });
    return {
      kind: parsed.kind,
      host,
      owner: parsed.owner,
      repository: parsed.repository,
      webUrl: parsed.webUrl,
    };
  }

  try {
    const parsed = new URL(raw);
    const host = parsed.hostname;
    const remote = parseRemoteParts({ host, pathname: parsed.pathname });
    return {
      kind: remote.kind,
      host,
      owner: remote.owner,
      repository: remote.repository,
      webUrl: remote.webUrl,
    };
  } catch {
    return { kind: "unknown", host: null, owner: null, repository: null, webUrl: null };
  }
}

function isHttpWebUrl(value: string | null | undefined): value is string {
  if (!value) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" || parsed.protocol === "http:";
  } catch {
    return false;
  }
}

/** Resolve the canonical browser URL without assuming every provider uses GitHub paths. */
export function resolveChangeRequestWebUrl(
  changeRequest: Pick<ChangeRequest, "displayNumber" | "id" | "provider" | "url">,
): string | null {
  if (isHttpWebUrl(changeRequest.url)) return changeRequest.url;

  const baseUrl = changeRequest.provider.webUrl?.replace(/\/+$/g, "");
  if (!isHttpWebUrl(baseUrl)) return null;
  const identifier = encodeURIComponent(changeRequest.displayNumber || changeRequest.id);
  switch (changeRequest.provider.kind) {
    case "github":
      return `${baseUrl}/pull/${identifier}`;
    case "gitlab":
      return `${baseUrl}/-/merge_requests/${identifier}`;
    case "bitbucket":
      return `${baseUrl}/pull-requests/${identifier}`;
    case "azure-devops":
      return `${baseUrl}/pullrequest/${identifier}`;
    case "unknown":
      return null;
  }
}
