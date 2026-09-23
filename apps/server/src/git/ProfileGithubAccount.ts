import { GithubCliProjection, type GithubProfilePaths } from "./GithubCliProjection";
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

class GithubSignInCancelled extends Error {
  constructor() {
    super("GitHub sign-in was cancelled.");
  }
}

const generations = new Map<string | ServerSecretStoreShape, Map<string, number>>();
const failures = new Set<string | ServerSecretStoreShape>();
const queues = new Map<string | ServerSecretStoreShape, Promise<unknown>>();

/** All managed Git and GitHub requests acquire credentials from this profile's secret store. */
export class ProfileGithubAccount {
  constructor(
    private readonly secrets: ServerSecretStoreShape,
    private readonly request: GithubAccountRequest = fetch,
    private readonly paths?: GithubProfilePaths,
  ) {}

  private get key() {
    return this.paths?.stateDir ?? this.secrets;
  }

  private nextGeneration(host: string): number {
    const hosts = generations.get(this.key) ?? new Map<string, number>();
    generations.set(this.key, hosts);
    const next = (hosts.get(host) ?? 0) + 1;
    hosts.set(host, next);
    return next;
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const key = this.paths?.stateDir ?? this.secrets;
    const previous = queues.get(key) ?? Promise.resolve();
    const next = previous
      .catch(() => {})
      .then(async () => {
        try {
          const result = await operation();
          failures.delete(key);
          return result;
        } catch (error) {
          if (!(error instanceof GithubSignInCancelled)) failures.add(key);
          throw error;
        }
      });
    queues.set(key, next);
    void next
      .finally(() => {
        if (queues.get(key) === next) queues.delete(key);
      })
      .catch(() => {});
    return next;
  }

  async reconcile(): Promise<void> {
    return this.serialize(async () => {
      if (this.paths) {
        const projection = new GithubCliProjection(this.paths, this.secrets);
        await projection.invalidate();
        await projection.rebuild();
      }
    });
  }

  async token(host: string): Promise<string | null> {
    await queues.get(this.key);
    if (failures.has(this.key))
      throw new Error(
        "GitHub credentials need reconciliation. Reconnect in Settings > Integrations.",
      );
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

  async set(
    host: string,
    token: string,
    isCurrent: () => boolean = () => true,
  ): Promise<{ login: string }> {
    host = accountHost(host);
    token = token.trim();
    if (!token || /[\r\n]/.test(token) || token.includes("\0"))
      throw new Error("Invalid GitHub token.");
    const generation = this.nextGeneration(host);
    const current = () => generations.get(this.key)?.get(host) === generation && isCurrent();
    const identity = await this.verify(host, token);
    return this.serialize(async () => {
      if (!current()) throw new GithubSignInCancelled();
      const projection = this.paths ? new GithubCliProjection(this.paths, this.secrets) : undefined;
      const oldToken = await Effect.runPromise(this.secrets.get(`github-token-${host}`));
      const oldLogin = await Effect.runPromise(this.secrets.get(`github-login-${host}`));
      await projection?.invalidate();
      if (!current()) {
        await projection?.rebuild();
        throw new GithubSignInCancelled();
      }
      await Effect.runPromise(
        this.secrets.set(`github-token-${host}`, new TextEncoder().encode(token)),
      );
      await Effect.runPromise(
        this.secrets.set(`github-login-${host}`, new TextEncoder().encode(identity.login)),
      );
      await projection?.rebuild();
      if (!current()) {
        await projection?.invalidate();
        if (oldToken) await Effect.runPromise(this.secrets.set(`github-token-${host}`, oldToken));
        else await Effect.runPromise(this.secrets.remove(`github-token-${host}`));
        await Effect.runPromise(
          this.secrets.set(`github-login-${host}`, oldLogin ?? new Uint8Array()),
        );
        await projection?.rebuild();
        throw new GithubSignInCancelled();
      }
      return identity;
    });
  }

  async status(host: string): Promise<{ login: string | null }> {
    const token = await this.token(host);
    return token ? this.verify(host, token) : { login: null };
  }

  async remove(host: string): Promise<void> {
    host = accountHost(host);
    this.nextGeneration(host);
    return this.serialize(async () => {
      const projection = this.paths ? new GithubCliProjection(this.paths, this.secrets) : undefined;
      await projection?.invalidate();
      await Effect.runPromise(this.secrets.remove(`github-token-${host}`));
      await Effect.runPromise(this.secrets.set(`github-login-${host}`, new Uint8Array()));
      await projection?.rebuild();
    });
  }
}
