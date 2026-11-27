import type { McpRepositoryServer } from "@t3tools/contracts";

const ENV_REFERENCE = /\$\{env:([A-Za-z_][A-Za-z0-9_]*)(?::-[^}]*)?\}/gu;

/**
 * Where a repository server's definition sends a value from your environment:
 * `${env:NAME}` references F5 fills in when the server starts, and
 * `bearerTokenEnvVar`, whose value is sent to the server's host as a bearer token.
 */
export function mcpRepositoryCredentialUses(server: McpRepositoryServer["server"]): string[] {
  const uses: string[] = [];
  const scan = (text: string, where: string) => {
    for (const match of text.matchAll(ENV_REFERENCE)) uses.push(`$${match[1]} → ${where}`);
  };
  if (server.type === "stdio") {
    scan(server.command, "the command");
    (server.args ?? []).forEach((arg, index) => scan(arg, `argument ${index + 1}`));
    for (const [key, value] of Object.entries(server.env ?? {}))
      scan(value, `environment variable ${key}`);
    if (server.cwd) scan(server.cwd, "the working directory");
    return uses;
  }
  const host = (() => {
    try {
      return new URL(server.url.replace(ENV_REFERENCE, "x")).host;
    } catch {
      return server.url;
    }
  })();
  scan(server.url, `the URL (${host})`);
  for (const [key, value] of Object.entries(server.headers ?? {}))
    scan(value, `header ${key}, sent to ${host}`);
  if (server.bearerTokenEnvVar)
    uses.push(`$${server.bearerTokenEnvVar} → Authorization: Bearer, sent to ${host}`);
  return uses;
}
