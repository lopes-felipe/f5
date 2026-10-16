/**
 * SQL persistence for the Agent Bridge authorization server: OAuth clients,
 * one-time authorization codes, and access/refresh tokens. Codes and tokens
 * are stored only as SHA-256 hashes.
 *
 * @module agentBridge/OAuthStore
 */
import { createHash, randomBytes } from "node:crypto";

import type { AgentBridgeScope } from "@t3tools/contracts";
import { Data, Effect } from "effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";

export const ACCESS_TOKEN_TTL_MS = 15 * 60 * 1000;
export const REFRESH_FAMILY_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const AUTH_CODE_TTL_MS = 60 * 1000;
export const MAX_DCR_CLIENTS = 20;
export const MAX_DCR_REGISTRATIONS_PER_HOUR = 10;

export class OAuthStoreError extends Data.TaggedError("OAuthStoreError")<{
  readonly operation: string;
  readonly cause: unknown;
}> {
  override get message(): string {
    return `Agent Bridge authorization storage failed during ${this.operation}.`;
  }
}

export const hashSecret = (value: string) => createHash("sha256").update(value).digest("hex");
export const mintSecret = () => randomBytes(32).toString("base64url");

const iso = (ms: number) => new Date(ms).toISOString();

export interface AuthCodeRecord {
  readonly clientId: string;
  readonly redirectUri: string;
  readonly codeChallenge: string;
  readonly resource: string;
  readonly scopes: ReadonlyArray<AgentBridgeScope>;
  readonly projectIds: ReadonlyArray<string>;
}

export interface TokenRecord {
  readonly kind: "access" | "refresh";
  readonly clientId: string;
  readonly familyId: string;
  readonly scopes: ReadonlyArray<AgentBridgeScope>;
  readonly resource: string;
  readonly grantGeneration: number;
  readonly expiresAt: string;
  readonly familyExpiresAt: string;
}

export interface IssuedTokens {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly expiresInSeconds: number;
  readonly scopes: ReadonlyArray<AgentBridgeScope>;
}

export type RefreshOutcome =
  | { readonly kind: "rotated"; readonly tokens: IssuedTokens; readonly clientId: string }
  | { readonly kind: "invalid" }
  /** A rotated token was presented again: the family is revoked and the grant fenced. */
  | { readonly kind: "reused"; readonly clientId: string };

interface TokenRow {
  readonly token_hash: string;
  readonly kind: "access" | "refresh";
  readonly client_id: string;
  readonly family_id: string;
  readonly scopes_json: string;
  readonly resource: string;
  readonly grant_generation: number;
  readonly expires_at: string;
  readonly family_expires_at: string;
  readonly consumed_at: string | null;
  readonly revoked_at: string | null;
}

export interface OAuthStore {
  readonly registerDcrClient: (input: {
    readonly name: string;
    readonly redirectUris: ReadonlyArray<string>;
    readonly at: number;
  }) => Effect.Effect<
    | { readonly ok: true; readonly clientId: string }
    | { readonly ok: false; readonly reason: "limit" | "rate" },
    OAuthStoreError
  >;
  /** Creates or refreshes a client-metadata-document client (its id is the document URL). */
  readonly upsertCimdClient: (input: {
    readonly clientId: string;
    readonly name: string;
    readonly redirectUris: ReadonlyArray<string>;
    readonly at: number;
  }) => Effect.Effect<void, OAuthStoreError>;
  /**
   * Sets a client's grant, clears any revocation, and increments its grant
   * generation. Returns the new generation.
   */
  readonly setGrant: (input: {
    readonly clientId: string;
    readonly scopes: ReadonlyArray<AgentBridgeScope>;
    readonly projectIds: ReadonlyArray<string>;
  }) => Effect.Effect<number, OAuthStoreError>;
  /** Marks a client revoked, deletes its tokens and codes, and increments its generation. */
  readonly revokeClient: (clientId: string, at: number) => Effect.Effect<void, OAuthStoreError>;
  /** Deletes every token and code (the issuer changed). */
  readonly revokeAllTokens: Effect.Effect<void, OAuthStoreError>;
  readonly insertCode: (
    record: AuthCodeRecord & { readonly at: number },
  ) => Effect.Effect<string, OAuthStoreError>;
  /** Consumes a code atomically; null when unknown, expired, or already used. */
  readonly consumeCode: (
    code: string,
    at: number,
  ) => Effect.Effect<AuthCodeRecord | null, OAuthStoreError>;
  readonly issueTokens: (input: {
    readonly clientId: string;
    readonly scopes: ReadonlyArray<AgentBridgeScope>;
    readonly resource: string;
    readonly grantGeneration: number;
    readonly at: number;
    /** Continue an existing refresh family (rotation) instead of starting one. */
    readonly family?: { readonly id: string; readonly expiresAt: string };
  }) => Effect.Effect<IssuedTokens, OAuthStoreError>;
  readonly rotateRefresh: (input: {
    readonly refreshToken: string;
    readonly clientId: string;
    readonly resource: string | null;
    readonly at: number;
    /** The client's current grant: the new tokens carry it. */
    readonly currentGrant: (
      clientId: string,
    ) => Effect.Effect<
      { readonly scopes: ReadonlyArray<AgentBridgeScope>; readonly generation: number } | null,
      OAuthStoreError
    >;
  }) => Effect.Effect<RefreshOutcome, OAuthStoreError>;
  readonly findAccessToken: (
    token: string,
    at: number,
  ) => Effect.Effect<TokenRecord | null, OAuthStoreError>;
  /** Removes expired codes and token families, in batches. */
  readonly sweepExpired: (at: number) => Effect.Effect<number, OAuthStoreError>;
}

export const makeOAuthStore = (sql: SqlClient.SqlClient): OAuthStore => {
  const fail =
    (operation: string) =>
    <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(Effect.mapError((cause) => new OAuthStoreError({ operation, cause })));

  const insertTokenRow = (input: {
    readonly hash: string;
    readonly kind: "access" | "refresh";
    readonly clientId: string;
    readonly familyId: string;
    readonly scopes: ReadonlyArray<AgentBridgeScope>;
    readonly resource: string;
    readonly generation: number;
    readonly at: number;
    readonly expiresAt: string;
    readonly familyExpiresAt: string;
  }) =>
    sql`INSERT INTO agent_bridge_tokens (token_hash, kind, client_id, family_id, scopes_json,
        resource, grant_generation, created_at, expires_at, family_expires_at)
      VALUES (${input.hash}, ${input.kind}, ${input.clientId}, ${input.familyId},
        ${JSON.stringify(input.scopes)}, ${input.resource}, ${input.generation}, ${iso(input.at)},
        ${input.expiresAt}, ${input.familyExpiresAt})`;

  const issueTokens: OAuthStore["issueTokens"] = (input) =>
    Effect.gen(function* () {
      const familyId = input.family?.id ?? mintSecret();
      const familyExpiresAt = input.family?.expiresAt ?? iso(input.at + REFRESH_FAMILY_TTL_MS);
      const accessToken = mintSecret();
      const refreshToken = mintSecret();
      const accessExpires = Math.min(input.at + ACCESS_TOKEN_TTL_MS, Date.parse(familyExpiresAt));
      const common = {
        clientId: input.clientId,
        familyId,
        scopes: input.scopes,
        resource: input.resource,
        generation: input.grantGeneration,
        at: input.at,
        familyExpiresAt,
      };
      yield* insertTokenRow({
        ...common,
        hash: hashSecret(accessToken),
        kind: "access",
        expiresAt: iso(accessExpires),
      });
      yield* insertTokenRow({
        ...common,
        hash: hashSecret(refreshToken),
        kind: "refresh",
        expiresAt: familyExpiresAt,
      });
      return {
        accessToken,
        refreshToken,
        expiresInSeconds: Math.max(1, Math.floor((accessExpires - input.at) / 1000)),
        scopes: input.scopes,
      };
    }).pipe(fail("issueTokens"));

  const bumpGeneration = (clientId: string) =>
    sql`UPDATE agent_bridge_clients SET grant_generation = grant_generation + 1
      WHERE id = ${clientId}`;

  return {
    registerDcrClient: (input) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            const active = yield* sql<{ n: number }>`SELECT COUNT(*) AS n FROM agent_bridge_clients
              WHERE kind = 'dcr' AND revoked_at IS NULL`;
            if ((active[0]?.n ?? 0) >= MAX_DCR_CLIENTS)
              return { ok: false, reason: "limit" } as const;
            const recent = yield* sql<{ n: number }>`SELECT COUNT(*) AS n FROM agent_bridge_clients
              WHERE kind = 'dcr' AND created_at > ${iso(input.at - 60 * 60 * 1000)}`;
            if ((recent[0]?.n ?? 0) >= MAX_DCR_REGISTRATIONS_PER_HOUR)
              return { ok: false, reason: "rate" } as const;
            const clientId = `dcr_${randomBytes(16).toString("hex")}`;
            yield* sql`INSERT INTO agent_bridge_clients (id, kind, name, label, scopes_json,
                project_ids_json, grant_generation, created_at, redirect_uris_json)
              VALUES (${clientId}, 'dcr', ${input.name}, NULL, '[]', '[]', 0, ${iso(input.at)},
                ${JSON.stringify(input.redirectUris)})`;
            return { ok: true, clientId } as const;
          }),
        )
        .pipe(fail("registerDcrClient")),

    upsertCimdClient: (input) =>
      sql`INSERT INTO agent_bridge_clients (id, kind, name, label, scopes_json, project_ids_json,
          grant_generation, created_at, redirect_uris_json)
        VALUES (${input.clientId}, 'cimd', ${input.name}, NULL, '[]', '[]', 0, ${iso(input.at)},
          ${JSON.stringify(input.redirectUris)})
        ON CONFLICT(id) DO UPDATE SET name = excluded.name,
          redirect_uris_json = excluded.redirect_uris_json`.pipe(
        Effect.asVoid,
        fail("upsertCimdClient"),
      ),

    setGrant: (input) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            yield* sql`UPDATE agent_bridge_clients SET scopes_json = ${JSON.stringify(input.scopes)},
                project_ids_json = ${JSON.stringify(input.projectIds)}, revoked_at = NULL,
                grant_generation = grant_generation + 1
              WHERE id = ${input.clientId}`;
            const rows = yield* sql<{ grant_generation: number }>`SELECT grant_generation
              FROM agent_bridge_clients WHERE id = ${input.clientId}`;
            return rows[0]?.grant_generation ?? 0;
          }),
        )
        .pipe(fail("setGrant")),

    revokeClient: (clientId, at) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            yield* sql`UPDATE agent_bridge_clients SET revoked_at = ${iso(at)},
                grant_generation = grant_generation + 1
              WHERE id = ${clientId}`;
            yield* sql`DELETE FROM agent_bridge_tokens WHERE client_id = ${clientId}`;
            yield* sql`DELETE FROM agent_bridge_auth_codes WHERE client_id = ${clientId}`;
          }),
        )
        .pipe(fail("revokeClient")),

    revokeAllTokens: sql
      .withTransaction(
        Effect.gen(function* () {
          yield* sql`DELETE FROM agent_bridge_tokens`;
          yield* sql`DELETE FROM agent_bridge_auth_codes`;
        }),
      )
      .pipe(fail("revokeAllTokens")),

    insertCode: (record) =>
      Effect.gen(function* () {
        const code = mintSecret();
        yield* sql`INSERT INTO agent_bridge_auth_codes (code_hash, client_id, redirect_uri,
            code_challenge, resource, scopes_json, project_ids_json, created_at, expires_at)
          VALUES (${hashSecret(code)}, ${record.clientId}, ${record.redirectUri},
            ${record.codeChallenge}, ${record.resource}, ${JSON.stringify(record.scopes)},
            ${JSON.stringify(record.projectIds)}, ${iso(record.at)},
            ${iso(record.at + AUTH_CODE_TTL_MS)})`;
        return code;
      }).pipe(fail("insertCode")),

    consumeCode: (code, at) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            const hash = hashSecret(code);
            const claimed = yield* sql<{ code_hash: string }>`UPDATE agent_bridge_auth_codes
              SET used_at = ${iso(at)}
              WHERE code_hash = ${hash} AND used_at IS NULL AND expires_at > ${iso(at)}
              RETURNING code_hash`;
            if (claimed.length === 0) return null;
            const rows = yield* sql<{
              client_id: string;
              redirect_uri: string;
              code_challenge: string;
              resource: string;
              scopes_json: string;
              project_ids_json: string;
            }>`SELECT client_id, redirect_uri, code_challenge, resource, scopes_json,
                project_ids_json
              FROM agent_bridge_auth_codes WHERE code_hash = ${hash}`;
            const row = rows[0];
            if (!row) return null;
            return {
              clientId: row.client_id,
              redirectUri: row.redirect_uri,
              codeChallenge: row.code_challenge,
              resource: row.resource,
              scopes: JSON.parse(row.scopes_json) as AgentBridgeScope[],
              projectIds: JSON.parse(row.project_ids_json) as string[],
            };
          }),
        )
        .pipe(fail("consumeCode")),

    issueTokens,

    rotateRefresh: (input) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            const hash = hashSecret(input.refreshToken);
            const rows = yield* sql<TokenRow>`SELECT * FROM agent_bridge_tokens
              WHERE token_hash = ${hash} AND kind = 'refresh'`;
            const row = rows[0];
            if (!row || row.client_id !== input.clientId) return { kind: "invalid" } as const;
            if (input.resource !== null && input.resource !== row.resource)
              return { kind: "invalid" } as const;
            if (row.consumed_at !== null || row.revoked_at !== null) {
              // Reuse of a rotated token: revoke the whole family and fence the grant.
              yield* sql`UPDATE agent_bridge_tokens SET revoked_at = ${iso(input.at)}
                WHERE family_id = ${row.family_id} AND revoked_at IS NULL`;
              yield* bumpGeneration(row.client_id);
              return { kind: "reused", clientId: row.client_id } as const;
            }
            if (Date.parse(row.family_expires_at) <= input.at) return { kind: "invalid" } as const;
            const grant = yield* input.currentGrant(row.client_id);
            if (!grant) return { kind: "invalid" } as const;
            const consumed = yield* sql<{ token_hash: string }>`UPDATE agent_bridge_tokens
              SET consumed_at = ${iso(input.at)}
              WHERE token_hash = ${hash} AND consumed_at IS NULL RETURNING token_hash`;
            if (consumed.length === 0) return { kind: "invalid" } as const;
            const tokens = yield* issueTokens({
              clientId: row.client_id,
              scopes: grant.scopes,
              resource: row.resource,
              grantGeneration: grant.generation,
              at: input.at,
              family: { id: row.family_id, expiresAt: row.family_expires_at },
            });
            return { kind: "rotated", tokens, clientId: row.client_id } as const;
          }),
        )
        .pipe(fail("rotateRefresh")),

    findAccessToken: (token, at) =>
      sql<TokenRow>`SELECT * FROM agent_bridge_tokens
        WHERE token_hash = ${hashSecret(token)} AND kind = 'access'`.pipe(
        Effect.map((rows) => {
          const row = rows[0];
          if (!row || row.revoked_at !== null || Date.parse(row.expires_at) <= at) return null;
          return {
            kind: row.kind,
            clientId: row.client_id,
            familyId: row.family_id,
            scopes: JSON.parse(row.scopes_json) as AgentBridgeScope[],
            resource: row.resource,
            grantGeneration: row.grant_generation,
            expiresAt: row.expires_at,
            familyExpiresAt: row.family_expires_at,
          } satisfies TokenRecord;
        }),
        fail("findAccessToken"),
      ),

    sweepExpired: (at) =>
      Effect.gen(function* () {
        const now = iso(at);
        const codes = yield* sql<{ code_hash: string }>`DELETE FROM agent_bridge_auth_codes
          WHERE code_hash IN (SELECT code_hash FROM agent_bridge_auth_codes
            WHERE expires_at <= ${now} LIMIT 100)
          RETURNING code_hash`;
        // Consumed refresh records stay until their family expires (reuse detection needs them).
        const tokens = yield* sql<{ token_hash: string }>`DELETE FROM agent_bridge_tokens
          WHERE token_hash IN (SELECT token_hash FROM agent_bridge_tokens
            WHERE family_expires_at <= ${now} LIMIT 100)
          RETURNING token_hash`;
        return codes.length + tokens.length;
      }).pipe(fail("sweepExpired")),
  };
};
