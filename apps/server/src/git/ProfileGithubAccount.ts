import { Effect } from "effect";
import type { ServerSecretStoreShape } from "../auth/Services/ServerSecretStore";

export type GithubAccountRequest = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

function accountHost(host: string): string {
  const normalized = host.toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(normalized) || normalized.includes(".."))
    throw new Error("Invalid GitHub hostname.");
  return normalized;
}

/** All managed Git and GitHub requests acquire credentials from this profile's secret store. */
export class ProfileGithubAccount {
  constructor(
    private readonly secrets: ServerSecretStoreShape,
    private readonly request: GithubAccountRequest = fetch,
  ) {}

  async token(host: string): Promise<string | null> {
    const value = await Effect.runPromise(this.secrets.get(`github-token-${accountHost(host)}`));
    return value ? new TextDecoder().decode(value) : null;
  }

  private async verify(host: string, token: string): Promise<{ login: string }> {
    const normalized = accountHost(host);
    const response = await this.request(
      normalized === "github.com"
        ? "https://api.github.com/user"
        : `https://${normalized}/api/v3/user`,
      {
        headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
        redirect: "error",
        signal: AbortSignal.timeout(15000),
      },
    );
    if (!response.ok) throw new Error(`GitHub account verification failed (${response.status}).`);
    const value = (await response.json()) as { login?: unknown };
    if (typeof value.login !== "string" || !value.login)
      throw new Error("GitHub returned an invalid account identity.");
    return { login: value.login };
  }

  async set(host: string, token: string): Promise<{ login: string }> {
    const identity = await this.verify(host, token);
    await Effect.runPromise(
      this.secrets.set(`github-token-${accountHost(host)}`, new TextEncoder().encode(token)),
    );
    return identity;
  }

  async status(host: string): Promise<{ login: string | null }> {
    const token = await this.token(host);
    return token ? this.verify(host, token) : { login: null };
  }

  async remove(host: string): Promise<void> {
    await Effect.runPromise(this.secrets.remove(`github-token-${accountHost(host)}`));
  }
}
