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
 *
 * Claims follow the reset-credit coordinator's rule: a claim whose outcome is
 * uncertain throws, so its request id stays pending and the retry reuses it.
 * Only answers that prove what happened (or prove nothing was spent) resolve.
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
/** A whole claim (store reads, one CLI refresh, the POST) fits the coordinator's 30s. */
const CLAIM_BUDGET_MS = 27_000;
/** Treat a token this close to expiry as expired. */
const TOKEN_EXPIRY_MARGIN_MS = 60_000;
/** How long background status reads skip the credential store after it finds nothing. */
const STORE_MISS_BACKOFF_MS = 30 * 60_000;
/** How long a status read stays usable when a refresh can't wait for a new one. */
const LAST_STATUS_TTL_MS = 15 * 60_000;
/** `security` exits with this when the Keychain item does not exist. */
const SECURITY_ITEM_NOT_FOUND = 44;
const GRANT_ID = /^[a-z0-9_-]{1,40}$/;
const REQUEST_ID = /^[A-Za-z0-9_-]{1,64}$/;
const KEYCHAIN_ACCOUNT = /^[a-zA-Z0-9._-]+$/;

export const CLAUDE_SIGN_IN_AGAIN_MESSAGE = "Sign in to Claude again, then retry.";
export const CLAUDE_KEYCHAIN_BLOCKED_MESSAGE =
  "F5 couldn't read Claude's sign-in from the Keychain. Allow access when macOS asks, then retry.";

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
  /** The Keychain refused or timed out (for example a denied prompt). */
  | { readonly kind: "blocked" }
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

/** A failed `security` run; `exitCode` is null when it was killed or could not start. */
export class SecurityCommandError extends Error {
  constructor(readonly exitCode: number | null) {
    super(`security exited with ${exitCode ?? "no exit code"}`);
    this.name = "SecurityCommandError";
  }
}

export interface ClaudeTokenSource {
  readonly configDir: string;
  readonly env: NodeJS.ProcessEnv;
  readonly platform: NodeJS.Platform;
  readonly fallbackUser: string;
  /** Runs `/usr/bin/security`; resolves stdout, rejects with SecurityCommandError. */
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
  let keychainBlocked = false;
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
    } catch (cause) {
      keychainBlocked = !(
        cause instanceof SecurityCommandError && cause.exitCode === SECURITY_ITEM_NOT_FOUND
      );
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
  return { kind: keychainBlocked ? "blocked" : "missing" };
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

/** A claim whose outcome is uncertain: retry with the same request id. */
export class ClaudeLimitResetRequestError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
  ) {
    super(message);
    this.name = "ClaudeLimitResetRequestError";
  }
}

const NO_CREDIT_REASONS = new Set(["no_grant", "expired", "unknown_grant"]);
/** `unavailable` reasons that say the grant itself can't be used, so nothing was spent. */
const DEFINITE_UNAVAILABLE_REASONS = new Set(["paused", "not_next_grant", "grant_id_required"]);

function definiteUnavailable(reason: string | null): UsageConsumeResetCreditResult {
  switch (reason) {
    case "paused":
      return { outcome: "unavailable", message: "This limit reset is paused." };
    case "not_next_grant":
      return { outcome: "unavailable", message: "Use the other limit reset first." };
    default:
      return { outcome: "unavailable", message: "Claude can't use this limit reset right now." };
  }
}

/**
 * Maps the claim endpoint's answer onto the shared reset-credit outcomes. Throws
 * ClaudeLimitResetRequestError when the answer does not settle the claim.
 */
export function mapClaudeClaimResult(value: unknown): UsageConsumeResetCreditResult {
  const record = asRecord(value);
  const result = asTrimmedString(record?.result);
  const reason = asTrimmedString(record?.reason);
  switch (result) {
    case "reset":
      return { outcome: "reset" };
    // Claude Code reads this as "the grant was already spent", not as a replay.
    case "already_used":
      return { outcome: "noCredit", message: "This limit reset was already used." };
    case "not_limited":
      return { outcome: "nothingToReset" };
    case "cooldown": {
      const retryAt = asIsoDateTime(record?.cooldown_until);
      return {
        outcome: "unavailable",
        message: retryAt
          ? "Limit resets are cooling down."
          : "Limit resets are cooling down. Try again later.",
        ...(retryAt ? { retryAt } : {}),
      };
    }
    case "ineligible":
      if (reason && NO_CREDIT_REASONS.has(reason))
        return { outcome: "noCredit", message: "This limit reset is no longer available." };
      return { outcome: "unavailable", message: "Claude can't use this limit reset right now." };
    case "unavailable":
      if (reason && NO_CREDIT_REASONS.has(reason))
        return { outcome: "noCredit", message: "This limit reset is no longer available." };
      if (reason && DEFINITE_UNAVAILABLE_REASONS.has(reason)) return definiteUnavailable(reason);
      // Claude Code keeps these claims unsettled and retries the same request id.
      throw new ClaudeLimitResetRequestError(
        "Claude couldn't confirm the reset yet. Retry to check the same claim.",
        null,
      );
    default:
      throw new ClaudeLimitResetRequestError(
        "Claude's reset response didn't say what happened. Retry to check the same claim.",
        null,
      );
  }
}

// ── Client ──────────────────────────────────────────────────────────────

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
  /** Background read. Never rejects or refreshes the token; any failure reads as null. */
  readonly fetchStatus: () => Promise<ClaudeLimitResets | null>;
  /** The last successful status read, while it is recent. */
  readonly lastKnownStatus: () => ClaudeLimitResets | null;
  /** Rejects with ClaudeLimitResetRequestError whenever the claim is not settled. */
  readonly claim: (
    grantId: string,
    requestId: string,
    signal?: AbortSignal,
  ) => Promise<UsageConsumeResetCreditResult>;
  readonly invalidate: () => void;
}

const isAuthFailure = (status: number) => status === 401 || status === 403;
/** Client errors that prove the request was rejected without spending a grant. */
const isDefiniteRejection = (status: number) =>
  status >= 400 && status < 500 && status !== 408 && status !== 429 && !isAuthFailure(status);

export function makeClaudeLimitResetClient(
  deps: ClaudeLimitResetClientDeps,
): ClaudeLimitResetClient {
  const baseUrl = deps.baseUrl ?? CLAUDE_API_BASE_URL;
  let cached: ClaudeOAuthToken | null = null;
  // After the store finds nothing, background reads wait before asking again.
  let storeMissUntil = 0;
  // After the Keychain refuses (a denied prompt), only a claim or sign-in asks again.
  let keychainBlocked = false;
  let lastStatus: { value: ClaudeLimitResets | null; at: number } | null = null;

  const readStore = async (): Promise<ClaudeTokenRead> => {
    cached = null;
    const read = await deps.readToken();
    keychainBlocked = read.kind === "blocked";
    storeMissUntil = read.kind === "token" ? 0 : deps.now() + STORE_MISS_BACKOFF_MS;
    if (read.kind === "token" && isClaudeTokenUsable(read.token, deps.now())) cached = read.token;
    return read;
  };

  const headers = (accessToken: string): Record<string, string> => ({
    Authorization: `Bearer ${accessToken}`,
    "anthropic-beta": OAUTH_BETA,
    "Content-Type": "application/json",
    "User-Agent": "F5",
  });

  const fetchStatus: ClaudeLimitResetClient["fetchStatus"] = async () => {
    try {
      if (!cached || !isClaudeTokenUsable(cached, deps.now())) {
        if (keychainBlocked || deps.now() < storeMissUntil) return null;
        await readStore();
      }
      const current = cached;
      if (!current) return null;
      const response = await deps.fetch(`${baseUrl}${CLAUDE_LIMIT_RESET_STATUS_PATH}`, {
        headers: headers(current.accessToken),
        signal: AbortSignal.timeout(STATUS_TIMEOUT_MS),
      });
      if (isAuthFailure(response.status)) cached = null;
      if (!response.ok) return null;
      const value = normalizeClaudeLimitResets(await response.json());
      lastStatus = { value, at: deps.now() };
      return value;
    } catch {
      return null;
    }
  };

  const claim: ClaudeLimitResetClient["claim"] = async (grantId, requestId, signal) => {
    // Nothing below may resolve without hearing from Claude: a local failure on a
    // recovered request id must leave it pending, never mark it settled.
    if (!GRANT_ID.test(grantId) || !REQUEST_ID.test(requestId))
      throw new ClaudeLimitResetRequestError("This limit reset can't be claimed.", null);
    const deadline = deps.now() + CLAIM_BUDGET_MS;
    const remaining = () => Math.max(0, deadline - deps.now());
    const organization = await deps.readOrganizationUuid();
    if (!organization) throw new ClaudeLimitResetRequestError(CLAUDE_SIGN_IN_AGAIN_MESSAGE, null);

    let refreshed = false;
    const refreshOnce = async () => {
      if (refreshed) return false;
      refreshed = true;
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        deps.refreshToken().catch(() => undefined),
        new Promise((resolve) => {
          timer = setTimeout(resolve, remaining());
        }),
      ]).finally(() => clearTimeout(timer));
      return true;
    };
    const usableToken = async (): Promise<ClaudeOAuthToken> => {
      if (cached && isClaudeTokenUsable(cached, deps.now())) return cached;
      let read = await readStore();
      if (!cached && read.kind === "token" && (await refreshOnce())) read = await readStore();
      if (cached) return cached;
      throw new ClaudeLimitResetRequestError(
        read.kind === "blocked" ? CLAUDE_KEYCHAIN_BLOCKED_MESSAGE : CLAUDE_SIGN_IN_AGAIN_MESSAGE,
        null,
      );
    };
    const send = async (accessToken: string) => {
      const timeout = AbortSignal.timeout(Math.min(CLAIM_TIMEOUT_MS, remaining()));
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
            signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
          },
        );
      } catch (cause) {
        throw new ClaudeLimitResetRequestError(
          cause instanceof Error && (cause.name === "TimeoutError" || cause.name === "AbortError")
            ? "Claude didn't answer the reset request in time."
            : "Couldn't reach Claude to claim the reset.",
          null,
        );
      }
    };

    let response = await send((await usableToken()).accessToken);
    if (isAuthFailure(response.status)) {
      // A rejected token never spends a grant, so one retry with a fresh token is safe.
      cached = null;
      if (await refreshOnce()) {
        await readStore();
        if (cached) response = await send((cached as ClaudeOAuthToken).accessToken);
      }
      if (isAuthFailure(response.status) || !cached) {
        cached = null;
        throw new ClaudeLimitResetRequestError(CLAUDE_SIGN_IN_AGAIN_MESSAGE, response.status);
      }
    }
    if (isDefiniteRejection(response.status)) {
      // A structured answer still says what happened; otherwise nothing was spent.
      const body: unknown = await response.json().catch(() => null);
      if (asTrimmedString(asRecord(body)?.result)) return mapClaudeClaimResult(body);
      return {
        outcome: "unavailable",
        message: `Claude rejected the reset request (HTTP ${response.status}).`,
      };
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
    lastKnownStatus: () =>
      lastStatus && deps.now() - lastStatus.at < LAST_STATUS_TTL_MS ? lastStatus.value : null,
    claim,
    invalidate: () => {
      cached = null;
      storeMissUntil = 0;
      keychainBlocked = false;
      lastStatus = null;
    },
  };
}
