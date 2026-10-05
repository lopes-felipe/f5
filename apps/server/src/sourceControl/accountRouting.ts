import { createHash, randomUUID } from "node:crypto";
import { Effect, Layer, Schema, ServiceMap, Semaphore } from "effect";
import { SqlClient } from "effect/unstable/sql";
import type {
  ForgeAccount,
  ForgeAccountInput,
  ForgeAccountRouting,
  SourceControlPullRequestRef,
  SourceControlProviderKind,
} from "@t3tools/contracts";
import { ServerSecretStore } from "../auth/Services/ServerSecretStore.ts";
import { SourceControlProviderError } from "./SourceControlProvider.ts";

export interface ForgeAccountsShape {
  readonly listAccounts: () => Effect.Effect<readonly ForgeAccount[], SourceControlProviderError>;
  readonly removeAccount: (accountId: string) => Effect.Effect<void, SourceControlProviderError>;
  readonly saveAccount: (
    input: ForgeAccountInput,
  ) => Effect.Effect<ForgeAccount, SourceControlProviderError>;
  readonly getToken: (accountId: string) => Effect.Effect<string, SourceControlProviderError>;
  readonly route: (
    ref: SourceControlPullRequestRef,
    cwd?: string,
  ) => Effect.Effect<ForgeAccount, SourceControlProviderError>;
  readonly setRouting: (
    input: ForgeAccountRouting,
  ) => Effect.Effect<void, SourceControlProviderError>;
  readonly listRouting: () => Effect.Effect<
    readonly ForgeAccountRouting[],
    SourceControlProviderError
  >;
  readonly resolveAccount: (input: {
    readonly ref?: SourceControlPullRequestRef;
    readonly cwd?: string;
  }) => Effect.Effect<
    ForgeAccount & {
      readonly kind: SourceControlProviderKind;
      readonly token: string;
      readonly repository: string;
    },
    SourceControlProviderError
  >;
}
export class ForgeAccounts extends ServiceMap.Service<ForgeAccounts, ForgeAccountsShape>()(
  "t3/sourceControl/accountRouting/ForgeAccounts",
) {}
interface AccountRow {
  id: string;
  provider: SourceControlProviderKind;
  host: string;
  login: string;
  viewer_id: string;
  generation: string;
}
const accountFromRow = (row: AccountRow): ForgeAccount => ({
  id: row.id,
  provider: row.provider,
  host: row.host,
  login: row.login,
  viewerId: row.viewer_id,
  generation: row.generation,
});
const failure = (
  provider: SourceControlProviderKind,
  detail: string,
  kind: SourceControlProviderError["kind"] = "generic",
) => new SourceControlProviderError({ provider, operation: "accountRouting", detail, kind });
const safeHost = (host: string) =>
  /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(host) && !host.includes("..") && host.length <= 253;
const safeRepository = (repository: string) =>
  repository.length <= 1024 &&
  repository.split("/").length >= 2 &&
  repository
    .split("/")
    .every(
      (part) =>
        !!part &&
        part !== "." &&
        part !== ".." &&
        !/[\\?#\s]/.test(part) &&
        !Array.from(part).some((character) => character.charCodeAt(0) < 32),
    );
const secretName = (account: ForgeAccount) => `forge-token-${account.id}-${account.generation}`;

export const makeForgeAccounts = (
  options: {
    readonly fetch?: (url: string | URL, init?: RequestInit) => Promise<Response>;
    readonly resolveRepository?: (
      cwd: string,
    ) => Effect.Effect<SourceControlPullRequestRef, SourceControlProviderError>;
  } = {},
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const secrets = yield* ServerSecretStore;
    const gate = yield* Semaphore.make(1);
    const dbError = () => failure("github", "Account storage is unavailable.");
    const listAccounts = () =>
      sql<AccountRow>`SELECT id,provider,host,login,viewer_id,generation FROM forge_accounts ORDER BY provider,host,login`.pipe(
        Effect.map((rows) => rows.map(accountFromRow)),
        Effect.mapError(dbError),
      );
    const byId = (id: string) =>
      sql<AccountRow>`SELECT id,provider,host,login,viewer_id,generation FROM forge_accounts WHERE id=${id}`.pipe(
        Effect.map((rows) => (rows[0] ? accountFromRow(rows[0]) : null)),
        Effect.mapError(dbError),
      );
    const tokenFor = (account: ForgeAccount) =>
      Effect.gen(function* () {
        const bytes = yield* secrets
          .get(secretName(account))
          .pipe(
            Effect.mapError(() =>
              failure(account.provider, "Account credentials are unavailable.", "unauthenticated"),
            ),
          );
        if (!bytes)
          return yield* failure(
            account.provider,
            "Account credentials are unavailable.",
            "unauthenticated",
          );
        return new TextDecoder().decode(bytes);
      });
    const getToken = (id: string) =>
      Effect.gen(function* () {
        const account = yield* byId(id);
        if (!account) return yield* failure("github", "Account was not found.", "not_found");
        return yield* tokenFor(account);
      });
    const saveAccount = (input: ForgeAccountInput) =>
      gate.withPermits(1)(
        Effect.gen(function* () {
          const host = input.host.toLowerCase(),
            provider = input.provider;
          if (
            !["github", "gitlab", "bitbucket", "azure-devops", "forgejo"].includes(provider) ||
            !safeHost(host) ||
            !input.token ||
            input.token.length > 16384 ||
            Array.from(input.token).some((character) => character.charCodeAt(0) < 32)
          )
            return yield* failure(provider, "Invalid account host or credentials.", "forbidden");
          if (
            (provider === "bitbucket" && host !== "bitbucket.org") ||
            (provider === "azure-devops" && host !== "dev.azure.com")
          )
            return yield* failure(provider, "This forge host is unsupported.", "unsupported");
          const organization = input.organization?.trim();
          if (
            provider === "azure-devops" &&
            (!organization || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(organization))
          )
            return yield* failure(
              provider,
              "An Azure DevOps organization is required to verify this token.",
              "forbidden",
            );
          const endpoint =
            provider === "github"
              ? host === "github.com"
                ? "https://api.github.com/user"
                : `https://${host}/api/v3/user`
              : provider === "gitlab"
                ? `https://${host}/api/v4/user`
                : provider === "forgejo"
                  ? `https://${host}/api/v1/user`
                  : provider === "bitbucket"
                    ? "https://api.bitbucket.org/2.0/user"
                    : `https://dev.azure.com/${encodeURIComponent(organization!)}/_apis/connectionData?api-version=7.1`;
          const identity = yield* Effect.tryPromise({
            try: async (signal) => {
              const headers: Record<string, string> = { Accept: "application/json" };
              if (provider === "gitlab") headers["PRIVATE-TOKEN"] = input.token;
              else
                headers.Authorization =
                  provider === "azure-devops"
                    ? `Basic ${Buffer.from(`:${input.token}`).toString("base64")}`
                    : `Bearer ${input.token}`;
              const response = await (options.fetch ?? globalThis.fetch)(endpoint, {
                headers,
                redirect: "error",
                signal,
              });
              if (!response.ok) {
                await response.body?.cancel();
                throw failure(
                  provider,
                  `Identity verification returned HTTP ${response.status}.`,
                  response.status === 401 ? "unauthenticated" : "forbidden",
                );
              }
              const reader = response.body?.getReader();
              if (!reader)
                throw failure(provider, "Identity response is empty.", "invalid_response");
              const chunks: Uint8Array[] = [];
              let length = 0;
              try {
                while (true) {
                  const chunk = await reader.read();
                  if (chunk.done) break;
                  length += chunk.value.byteLength;
                  if (length > 65536)
                    throw failure(
                      provider,
                      "Identity response exceeds the limit.",
                      "invalid_response",
                    );
                  chunks.push(chunk.value);
                }
              } finally {
                await reader.cancel();
              }
              const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
              const record =
                value && typeof value === "object" && !Array.isArray(value)
                  ? (value as Record<string, unknown>)
                  : {};
              const user =
                provider === "azure-devops" &&
                record.authenticatedUser &&
                typeof record.authenticatedUser === "object"
                  ? (record.authenticatedUser as Record<string, unknown>)
                  : record;
              const login =
                user.login ??
                user.username ??
                user.nickname ??
                user.providerDisplayName ??
                user.customDisplayName;
              const viewerId = user.id ?? user.uuid ?? user.account_id;
              if (
                typeof login !== "string" ||
                !login.trim() ||
                login.length > 512 ||
                !(typeof viewerId === "string" || typeof viewerId === "number")
              )
                throw failure(provider, "Identity response is invalid.", "invalid_response");
              return { login, viewerId: String(viewerId) };
            },
            catch: (cause) =>
              Schema.is(SourceControlProviderError)(cause)
                ? cause
                : failure(provider, "Identity verification failed.", "network"),
          }).pipe(
            Effect.timeoutOrElse({
              duration: "15 seconds",
              onTimeout: () =>
                Effect.fail(failure(provider, "Identity verification timed out.", "timeout")),
            }),
          );
          const id = `forge-${createHash("sha256")
            .update(JSON.stringify([provider, host, identity.login]))
            .digest("hex")}`;
          const account: ForgeAccount = {
            id,
            provider,
            host,
            ...identity,
            generation: randomUUID(),
          };
          const previous = yield* byId(id);
          // Immutable generation secrets ensure failed SQL publication cannot replace a routed token.
          yield* secrets
            .set(secretName(account), new TextEncoder().encode(input.token))
            .pipe(
              Effect.mapError(() =>
                failure(provider, "Could not securely store account credentials."),
              ),
            );
          yield* sql`INSERT INTO forge_accounts (id,provider,host,login,viewer_id,generation) VALUES (${id},${provider},${host},${identity.login},${identity.viewerId},${account.generation}) ON CONFLICT(provider,host,login) DO UPDATE SET viewer_id=excluded.viewer_id,generation=excluded.generation`.pipe(
            Effect.mapError(dbError),
          );
          if (previous) yield* secrets.remove(secretName(previous)).pipe(Effect.mapError(dbError));
          return account;
        }),
      );
    const removeAccount = (id: string) =>
      gate.withPermits(1)(
        Effect.gen(function* () {
          const account = yield* byId(id);
          if (!account) return;
          const running =
            yield* sql`SELECT operation_id FROM forge_operations WHERE account_id=${id} AND status IN ('running','outcome_unknown')`.pipe(
              Effect.mapError(dbError),
            );
          if (running.length)
            return yield* failure(
              account.provider,
              "Resolve outstanding operations before removing this account.",
              "forbidden",
            );
          yield* secrets.remove(secretName(account)).pipe(Effect.mapError(dbError));
          yield* sql
            .withTransaction(
              Effect.gen(function* () {
                yield* sql`DELETE FROM forge_account_routing WHERE account_id=${id}`;
                yield* sql`DELETE FROM forge_accounts WHERE id=${id}`;
              }),
            )
            .pipe(Effect.mapError(dbError));
        }),
      );
    const listRouting = () =>
      sql<{
        provider: SourceControlProviderKind;
        host: string;
        repository: string;
        account_id: string;
      }>`SELECT provider,host,repository,account_id FROM forge_account_routing ORDER BY provider,host,repository`.pipe(
        Effect.map((rows) =>
          rows.map((row) => ({
            provider: row.provider,
            host: row.host,
            repository: row.repository,
            accountId: row.account_id,
          })),
        ),
        Effect.mapError(dbError),
      );
    const setRouting = (input: ForgeAccountRouting) =>
      Effect.gen(function* () {
        const account = yield* byId(input.accountId),
          host = input.host.toLowerCase();
        if (
          !account ||
          account.provider !== input.provider ||
          account.host !== host ||
          !safeRepository(input.repository)
        )
          return yield* failure(
            input.provider,
            "Routing must match the account provider, host and repository.",
            "forbidden",
          );
        yield* sql`INSERT INTO forge_account_routing (provider,host,repository,account_id) VALUES (${input.provider},${host},${input.repository},${input.accountId}) ON CONFLICT(provider,host,repository) DO UPDATE SET account_id=excluded.account_id`.pipe(
          Effect.mapError(dbError),
        );
      });
    const route = (ref: SourceControlPullRequestRef, _cwd?: string) =>
      Effect.gen(function* () {
        const host = ref.host.toLowerCase();
        if (
          !["github", "gitlab", "bitbucket", "azure-devops", "forgejo"].includes(ref.provider) ||
          !safeHost(host) ||
          !safeRepository(ref.repository)
        )
          return yield* failure(ref.provider, "Invalid repository routing reference.", "forbidden");
        const routing = yield* sql<{
          account_id: string;
        }>`SELECT account_id FROM forge_account_routing WHERE provider=${ref.provider} AND host=${host} AND repository=${ref.repository}`.pipe(
          Effect.mapError(dbError),
        );
        if (routing[0]) {
          const account = yield* byId(routing[0].account_id);
          if (account && account.provider === ref.provider && account.host === host) return account;
          return yield* failure(
            ref.provider,
            "Configured account routing is invalid.",
            "forbidden",
          );
        }
        const accounts = (yield* listAccounts()).filter(
          (account) => account.provider === ref.provider && account.host === host,
        );
        if (accounts.length !== 1)
          return yield* failure(
            ref.provider,
            accounts.length
              ? "Choose an account for this repository."
              : "No account is configured for this forge host.",
            "unauthenticated",
          );
        return accounts[0]!;
      });
    const resolveAccount = (input: {
      readonly ref?: SourceControlPullRequestRef;
      readonly cwd?: string;
    }) =>
      Effect.gen(function* () {
        const ref =
          input.ref ??
          (input.cwd && options.resolveRepository
            ? yield* options.resolveRepository(input.cwd)
            : undefined);
        if (!ref)
          return yield* failure(
            "github",
            "An explicit repository reference is required.",
            "forbidden",
          );
        const account = yield* route(ref, input.cwd),
          token = yield* tokenFor(account);
        return { ...account, kind: account.provider, token, repository: ref.repository };
      });
    return {
      listAccounts,
      saveAccount,
      removeAccount,
      getToken,
      route,
      setRouting,
      listRouting,
      resolveAccount,
    } satisfies ForgeAccountsShape;
  });
export const ForgeAccountsLive = Layer.effect(ForgeAccounts, makeForgeAccounts());
