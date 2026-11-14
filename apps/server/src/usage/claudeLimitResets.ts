/**
 * Claude plan limit resets ("Full reset", "Fable reset", ...).
 *
 * The Agent SDK exposes no API for these. Claude Code claims them only from its
 * interactive `/rate-limit-options` dialog, through two claude.ai endpoints that
 * this module calls directly with the OAuth access token the CLI stores. F5 only
 * reads that token: it never calls the token endpoint, so it cannot rotate the
 * CLI's refresh token. When the token has expired, the caller's `refreshToken`
 * runs a CLI probe, which refreshes and stores a new one.
 *
 * The endpoints are undocumented and can change with any Claude Code release.
 * Every read failure degrades to "no limit resets", never to a card error.
 */
import { createHash } from "node:crypto";
import * as NodePath from "node:path";

import type { ClaudeLimitResetGrant, ClaudeLimitResets } from "@t3tools/contracts";
import type { UsageConsumeResetCreditResult } from "@t3tools/contracts";

import {
  asIsoDateTime,
  asNonNegativeInteger,
  asRecord,
  asTrimmedString,
} from "./accountUsageJson.ts";

export const CLAUDE_API_BASE_URL = "https://api.anthropic.com";
export const CLAUDE_LIMIT_RESET_PROGRAM = "cedar_ember";
export const CLAUDE_LIMIT_RESET_STATUS_PATH = "/api/oauth/usage?cedar_ember=1&skip_spend=1";
const OAUTH_BETA = "oauth-2025-04-20";
const STATUS_TIMEOUT_MS = 12_000;
const CLAIM_TIMEOUT_MS = 25_000;
/** Treat a token this close to expiry as expired. */
const TOKEN_EXPIRY_MARGIN_MS = 60_000;
/** How long background status reads skip the credential store after it finds nothing. */
const STORE_MISS_BACKOFF_MS = 30 * 60_000;
const GRANT_ID = /^[a-z0-9_-]{1,40}$/;
const REQUEST_ID = /^[A-Za-z0-9_-]{1,64}$/;
const KEYCHAIN_ACCOUNT = /^[a-zA-Z0-9._-]+$/;

export const CLAUDE_SIGN_IN_AGAIN_MESSAGE = "Sign in to Claude again, then retry.";

// ── Credential location ─────────────────────────────────────────────────

/**
 * Mirrors Claude Code's secure-storage service name: `Claude Code-credentials`,
 * suffixed with the first 8 hex digits of sha256(config dir) when the config dir
 * is not the default one.
 */
export function claudeCredentialsService(env: NodeJS.ProcessEnv, configDir: string): string {
  const override = env.CLAUDE_SECURESTORAGE_CONFIG_DIR;
  const isDefault = override !== undefined ? !override : !env.CLAUDE_CONFIG_DIR;
  const dir = (override !== undefined ? override : configDir).normalize("NFC");
  const suffix = isDefault ? "" : `-${createHash("sha256").update(dir).digest("hex").slice(0, 8)}`;
  return `Claude Code-credentials${suffix}`;
}

/** Mirrors Claude Code's Keychain account: `$USER`, or a fixed name when unusable. */
export function claudeCredentialsAccount(env: NodeJS.ProcessEnv, fallbackUser: string): string {
  const user = env.USER || fallbackUser;
  return user && KEYCHAIN_ACCOUNT.test(user) ? user : "claude-code-user";
}

export interface ClaudeOAuthToken {
  readonly accessToken: string;
  /** Epoch milliseconds, or null when the store does not say. */
  readonly expiresAt: number | null;
}

export type ClaudeTokenRead =
  | { readonly kind: "token"; readonly token: ClaudeOAuthToken }
  | { readonly kind: "missing" }
  | { readonly kind: "unsupported" };

/** Parses the stored credentials payload. Never includes token text in results. */
export function parseClaudeCredentials(text: string): ClaudeOAuthToken | null {
  let raw = text.trim();
  // Some storage paths write the payload hex-encoded.
  if (raw.length > 0 && raw.length % 2 === 0 && /^[0-9a-f]+$/i.test(raw)) {
    raw = Buffer.from(raw, "hex").toString("utf8");
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  const oauth = asRecord(asRecord(value)?.claudeAiOauth);
  const accessToken = asTrimmedString(oauth?.accessToken);
  if (!accessToken) return null;
  const expiresAt =
    typeof oauth?.expiresAt === "number" && Number.isFinite(oauth.expiresAt)
      ? oauth.expiresAt
      : null;
  return { accessToken, expiresAt };
}

export interface ClaudeTokenSource {
  readonly configDir: string;
  readonly env: NodeJS.ProcessEnv;
  readonly platform: NodeJS.Platform;
  readonly fallbackUser: string;
  /** Runs `/usr/bin/security` with these args and resolves its stdout; rejects on failure. */
  readonly runSecurity: (args: ReadonlyArray<string>) => Promise<string>;
  readonly readFile: (path: string) => Promise<string>;
  /** True when the instance talks to a non-Anthropic API endpoint. */
  readonly customEndpoint?: boolean;
}

/** Reads the OAuth token Claude Code stores for this config dir. */
export async function readClaudeOAuthToken(source: ClaudeTokenSource): Promise<ClaudeTokenRead> {
  if (source.env.CLAUDE_CODE_CUSTOM_OAUTH_URL || source.customEndpoint) {
    return { kind: "unsupported" };
  }
  if (source.platform === "darwin") {
    try {
      const output = await source.runSecurity([
        "find-generic-password",
        "-a",
        claudeCredentialsAccount(source.env, source.fallbackUser),
        "-w",
        "-s",
        claudeCredentialsService(source.env, source.configDir),
      ]);
      const token = parseClaudeCredentials(output);
      if (token) return { kind: "token", token };
    } catch {
      // Fall through to the plaintext fallback store.
    }
  }
  try {
    const token = parseClaudeCredentials(
      await source.readFile(NodePath.join(source.configDir, ".credentials.json")),
    );
    if (token) return { kind: "token", token };
  } catch {
    // No plaintext store.
  }
  return { kind: "missing" };
}

export function isClaudeTokenUsable(token: ClaudeOAuthToken, now: number): boolean {
  return token.expiresAt === null || token.expiresAt - TOKEN_EXPIRY_MARGIN_MS > now;
}

// ── Status normalization ────────────────────────────────────────────────

function stringList(value: unknown): Array<string> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const text = asTrimmedString(entry);
    return text ? [text] : [];
  });
}

function defaultGrantLabel(kind: ClaudeLimitResetGrant["kind"]): string {
  switch (kind) {
    case "full":
      return "Full reset";
    case "session":
      return "Session reset";
    case "weekly":
      return "Weekly reset";
    default:
      return "Limit reset";
  }
}

function normalizeGrant(value: unknown): ClaudeLimitResetGrant | null {
  const grant = asRecord(value);
  const id = asTrimmedString(grant?.id);
  const resetsLeft = asNonNegativeInteger(grant?.resets_left);
  if (!grant || !id || !GRANT_ID.test(id) || resetsLeft === null) return null;
  const kind =
    grant.type === "session" || grant.type === "weekly" || grant.type === "full"
      ? grant.type
      : null;
  return {
    id,
    label: asTrimmedString(grant.label) ?? defaultGrantLabel(kind),
    kind,
    resetsLeft,
    resetsTotal: Math.max(asNonNegativeInteger(grant.resets_total) ?? 0, resetsLeft),
    endsAt: asIsoDateTime(grant.ends_at),
    usableNow: grant.usable_now === true,
    useRequiresLimit: grant.use_requires_limit !== false,
    givesBackWeekly: grant.gives_back_weekly === true,
    paused: grant.paused === true,
    clears: stringList(grant.clears),
    blocking: stringList(grant.blocking),
    unavailableReason: asTrimmedString(grant.unavailable_reason),
  };
}

/**
 * Normalizes the `cedar_ember` block of the usage response. Returns null when
 * the account has no limit resets (missing block, ineligible, or unavailable).
 */
export function normalizeClaudeLimitResets(response: unknown): ClaudeLimitResets | null {
  const block = asRecord(asRecord(response)?.cedar_ember);
  if (!block || block.eligible !== true || block.ineligible_reason === "unavailable") return null;
  const grants = Array.isArray(block.grants)
    ? block.grants.flatMap((entry) => {
        const grant = normalizeGrant(entry);
        return grant ? [grant] : [];
      })
    : [];
  const next = asTrimmedString(block.next_grant_id);
  return {
    grants,
    nextGrantId: next && grants.some((grant) => grant.id === next) ? next : null,
    cooldownUntil: asIsoDateTime(block.cooldown_until),
  };
}

// ── Claim mapping ───────────────────────────────────────────────────────

const NO_CREDIT_REASONS = new Set(["no_grant", "expired", "unknown_grant"]);

function formatRetryAt(iso: string | null): string | null {
  if (!iso) return null;
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function unavailableMessage(result: string, reason: string | null, cooldownUntil: string | null) {
  if (result === "cooldown" || reason === "cooldown") {
    const at = formatRetryAt(cooldownUntil);
    return at
      ? `Limit resets are cooling down. Try again after ${at}.`
      : "Limit resets are cooling down. Try again later.";
  }
  switch (reason) {
    case "paused":
      return "This limit reset is paused.";
    case "not_next_grant":
      return "Use the other limit reset first.";
    case "reset_unconfirmed":
    case "stamp_indeterminate":
      return "Claude couldn't confirm the reset. Check your usage before retrying.";
    default:
      return "Claude can't use this limit reset right now.";
  }
}

/** Maps the claim endpoint's response onto the shared reset-credit outcomes. */
export function mapClaudeClaimResult(value: unknown): UsageConsumeResetCreditResult {
  const record = asRecord(value);
  const result = asTrimmedString(record?.result) ?? "unavailable";
  const reason = asTrimmedString(record?.reason);
  switch (result) {
    case "reset":
      return { outcome: "reset" };
    case "already_used":
      return { outcome: "alreadyRedeemed" };
    case "not_limited":
      return { outcome: "nothingToReset" };
    case "ineligible":
      if (reason && NO_CREDIT_REASONS.has(reason)) return { outcome: "noCredit" };
      return { outcome: "unavailable", message: unavailableMessage(result, reason, null) };
    default:
      return {
        outcome: "unavailable",
        message: unavailableMessage(result, reason, asIsoDateTime(record?.cooldown_until)),
      };
  }
}

// ── Client ──────────────────────────────────────────────────────────────

/** A claim request that may or may not have reached Claude: retry with the same request id. */
export class ClaudeLimitResetRequestError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
  ) {
    super(message);
    this.name = "ClaudeLimitResetRequestError";
  }
}

export interface ClaudeLimitResetClientDeps {
  readonly readToken: () => Promise<ClaudeTokenRead>;
  /** The OAuth organization UUID, or null when unknown. */
  readonly readOrganizationUuid: () => Promise<string | null>;
  /** Makes the CLI refresh its stored token (for example by running a usage probe). */
  readonly refreshToken: () => Promise<void>;
  readonly fetch: (url: string, init: RequestInit) => Promise<Response>;
  readonly now: () => number;
  readonly baseUrl?: string;
}

export interface ClaudeLimitResetClient {
  /** Never rejects: any failure reads as null. Does not refresh the token. */
  readonly fetchStatus: () => Promise<ClaudeLimitResets | null>;
  /** Rejects with ClaudeLimitResetRequestError when the outcome is uncertain. */
  readonly claim: (grantId: string, requestId: string) => Promise<UsageConsumeResetCreditResult>;
  readonly invalidate: () => void;
}

const isAuthFailure = (status: number) => status === 401 || status === 403;

export function makeClaudeLimitResetClient(
  deps: ClaudeLimitResetClientDeps,
): ClaudeLimitResetClient {
  const baseUrl = deps.baseUrl ?? CLAUDE_API_BASE_URL;
  let cached: ClaudeOAuthToken | null = null;
  // After a store read finds nothing (for example a denied Keychain prompt),
  // background status reads wait instead of prompting on every refresh.
  let storeMissUntil = 0;

  const token = async (reload: boolean): Promise<ClaudeOAuthToken | null> => {
    if (!reload && cached && isClaudeTokenUsable(cached, deps.now())) return cached;
    cached = null;
    const read = await deps.readToken();
    if (read.kind !== "token") {
      storeMissUntil = deps.now() + STORE_MISS_BACKOFF_MS;
      return null;
    }
    storeMissUntil = 0;
    if (!isClaudeTokenUsable(read.token, deps.now())) return null;
    cached = read.token;
    return cached;
  };

  const headers = (accessToken: string): Record<string, string> => ({
    Authorization: `Bearer ${accessToken}`,
    "anthropic-beta": OAUTH_BETA,
    "Content-Type": "application/json",
    "User-Agent": "F5",
  });

  const fetchStatus: ClaudeLimitResetClient["fetchStatus"] = async () => {
    try {
      if (!cached && deps.now() < storeMissUntil) return null;
      const current = await token(false);
      if (!current) return null;
      const response = await deps.fetch(`${baseUrl}${CLAUDE_LIMIT_RESET_STATUS_PATH}`, {
        headers: headers(current.accessToken),
        signal: AbortSignal.timeout(STATUS_TIMEOUT_MS),
      });
      if (isAuthFailure(response.status)) cached = null;
      if (!response.ok) return null;
      return normalizeClaudeLimitResets(await response.json());
    } catch {
      return null;
    }
  };

  const claim: ClaudeLimitResetClient["claim"] = async (grantId, requestId) => {
    if (!GRANT_ID.test(grantId) || !REQUEST_ID.test(requestId)) {
      return { outcome: "unavailable", message: "This limit reset can't be claimed." };
    }
    const organization = await deps.readOrganizationUuid();
    if (!organization) return { outcome: "unavailable", message: CLAUDE_SIGN_IN_AGAIN_MESSAGE };
    const send = async (accessToken: string) => {
      try {
        return await deps.fetch(
          `${baseUrl}/api/organizations/${encodeURIComponent(organization)}/reset_rate_limits`,
          {
            method: "POST",
            headers: headers(accessToken),
            body: JSON.stringify({
              program: CLAUDE_LIMIT_RESET_PROGRAM,
              grant_id: grantId,
              request_id: requestId,
            }),
            signal: AbortSignal.timeout(CLAIM_TIMEOUT_MS),
          },
        );
      } catch (cause) {
        throw new ClaudeLimitResetRequestError(
          cause instanceof Error && cause.name === "TimeoutError"
            ? "Claude didn't answer the reset request in time."
            : "Couldn't reach Claude to claim the reset.",
          null,
        );
      }
    };
    let current = await token(false);
    if (!current) {
      await deps.refreshToken().catch(() => undefined);
      current = await token(true);
      if (!current) return { outcome: "unavailable", message: CLAUDE_SIGN_IN_AGAIN_MESSAGE };
    }
    let response = await send(current.accessToken);
    if (isAuthFailure(response.status)) {
      // A rejected token never spends a grant, so one retry with a fresh token is safe.
      cached = null;
      await deps.refreshToken().catch(() => undefined);
      current = await token(true);
      if (!current) return { outcome: "unavailable", message: CLAUDE_SIGN_IN_AGAIN_MESSAGE };
      response = await send(current.accessToken);
      if (isAuthFailure(response.status)) {
        cached = null;
        return { outcome: "unavailable", message: CLAUDE_SIGN_IN_AGAIN_MESSAGE };
      }
    }
    if (response.status === 429)
      throw new ClaudeLimitResetRequestError(
        "Claude is rate limiting reset requests. Retry shortly.",
        429,
      );
    if (!response.ok)
      throw new ClaudeLimitResetRequestError(
        `Claude answered the reset request with HTTP ${response.status}.`,
        response.status,
      );
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new ClaudeLimitResetRequestError("Claude's reset response was unreadable.", null);
    }
    return mapClaudeClaimResult(body);
  };

  return {
    fetchStatus,
    claim,
    invalidate: () => {
      cached = null;
      storeMissUntil = 0;
    },
  };
}
