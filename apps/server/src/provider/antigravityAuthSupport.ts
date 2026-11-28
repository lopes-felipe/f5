/**
 * Antigravity account and sign-in support shared by the runtime, text generation, account jobs
 * and the limits reader. Module name matches upstream T3 Code so future ports stay cheap.
 */
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import path from "node:path";
import {
  ANTIGRAVITY_AUTH_METHODS,
  ANTIGRAVITY_EXPOSED_AUTH_METHODS,
  type AntigravityAuthMethod,
  type AntigravitySettings,
} from "@t3tools/contracts";

export interface AntigravityAuthConfig {
  readonly authMethod: AntigravityAuthMethod;
  /** Only read for `gemini-api-key`; never comes from instance variables or the host. */
  readonly apiKey: string;
}

export const ANTIGRAVITY_PERSONAL_AUTH: AntigravityAuthConfig = {
  authMethod: "oauth-personal",
  apiKey: "",
};

export function antigravityAuthConfig(
  settings: Pick<AntigravitySettings, "authMethod" | "apiKey">,
): AntigravityAuthConfig {
  return { authMethod: settings.authMethod, apiKey: settings.apiKey.trim() };
}

export function isAntigravityAuthMethodExposed(method: AntigravityAuthMethod): boolean {
  return (ANTIGRAVITY_EXPOSED_AUTH_METHODS as ReadonlyArray<string>).includes(method);
}

export function antigravityAuthLabel(method: AntigravityAuthMethod): string {
  return ANTIGRAVITY_AUTH_METHODS.find((entry) => entry.value === method)?.label ?? method;
}

export function antigravityAuthUsesBrowser(method: AntigravityAuthMethod): boolean {
  return method === "oauth-personal" || method === "oauth-business";
}

/**
 * Host variables that would let the harness pick a credential, project or home other than the
 * instance's own. Compared case-insensitively because Windows environment keys are.
 */
const STRIPPED_VARIABLES = new Set([
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "GOOGLE_GENAI_USE_VERTEXAI",
  "GOOGLE_OAUTH_ACCESS_TOKEN",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "GOOGLE_CLOUD_PROJECT",
  "GOOGLE_CLOUD_LOCATION",
  "GOOGLE_CLOUD_QUOTA_PROJECT",
  "GCLOUD_PROJECT",
  "CLOUDSDK_CORE_PROJECT",
  "GEMINI_HOME",
  "ANTIGRAVITY_HARNESS_PATH",
  "BROWSER",
  "ELECTRON_RUN_AS_NODE",
]);
const isStripped = (key: string) => {
  const upper = key.toUpperCase();
  return STRIPPED_VARIABLES.has(upper) || upper.startsWith("AGY_ACP_");
};

/**
 * The environment for every `agy` process of an instance. Credentials and project selectors are
 * stripped from the inherited environment first; only what the selected method consumes is then
 * re-added.
 */
export function antigravityLaunchEnvironment(input: {
  readonly base: NodeJS.ProcessEnv;
  readonly home: string;
  readonly harness: string | undefined;
  readonly browserCommand: string;
  readonly auth: AntigravityAuthConfig;
}): NodeJS.ProcessEnv {
  const inherited = Object.fromEntries(
    Object.entries(input.base).filter(([key]) => !isStripped(key)),
  );
  return {
    ...inherited,
    ...(input.auth.authMethod === "gemini-api-key" && input.auth.apiKey
      ? { GEMINI_API_KEY: input.auth.apiKey }
      : {}),
    GEMINI_HOME: input.home,
    AGY_ACP_FORCE_FILE_STORAGE: "1",
    ...(input.harness ? { ANTIGRAVITY_HARNESS_PATH: input.harness } : {}),
    // The 1.5 CLI keeps Google sign-ins in one OS keyring entry for every profile unless it
    // believes it runs over SSH; file storage keeps each instance's sign-in in its profile.
    ...(input.auth.authMethod === "oauth-personal"
      ? { SSH_CONNECTION: input.base.SSH_CONNECTION || "127.0.0.1 0 127.0.0.1 0" }
      : {}),
    // agy only honors the literal "true"; "1" leaves self-update (and its update lookups) on.
    AGY_CLI_DISABLE_AUTO_UPDATE: "true",
    BROWSER: input.browserCommand,
    PYTHONUNBUFFERED: "1",
  };
}

/** `settings.json` names the selected method; it never holds a credential. */
export function antigravityProfileSettings(auth: AntigravityAuthConfig): string {
  return JSON.stringify({ auth: { type: auth.authMethod } });
}

/** Removes the API key from native logs, diagnostics and account output. */
export function redactAntigravityKey(text: string, apiKey: string | undefined): string {
  const key = apiKey?.trim();
  return key && key.length >= 8 ? text.replaceAll(key, "[API key redacted]") : text;
}

export function antigravityKeyFingerprint(apiKey: string): string {
  return createHash("sha256").update("f5-antigravity-key\0").update(apiKey.trim()).digest("hex");
}

// ── Published sign-in identity (stale adapter fence) ────────────────────────

/** The method and key an adapter runs with, without the key itself. */
export function antigravityAuthIdentity(auth: AntigravityAuthConfig): string {
  return JSON.stringify([
    auth.authMethod,
    auth.authMethod === "gemini-api-key" && auth.apiKey
      ? antigravityKeyFingerprint(auth.apiKey)
      : "",
  ]);
}

/** Sign-in config from an untyped provider-instance config (settings transactions). */
export function antigravityAuthConfigFromRaw(config: unknown): AntigravityAuthConfig {
  const fields =
    config !== null && typeof config === "object" ? (config as Record<string, unknown>) : {};
  const authMethod =
    ANTIGRAVITY_AUTH_METHODS.find((entry) => entry.value === fields.authMethod)?.value ??
    "oauth-personal";
  return { authMethod, apiKey: typeof fields.apiKey === "string" ? fields.apiKey.trim() : "" };
}

// Settings record the identity they publish while holding the account guard. An instance
// built from older settings keeps running until the registry replaces it, but refuses new work.
const publishedIdentities = new Map<string, string>();
const identityKey = (stateDir: string, instanceId: string) =>
  JSON.stringify([stateDir, instanceId]);

/** Record the identity settings are about to publish; the returned function undoes it. */
export function publishAntigravityAuthIdentity(
  stateDir: string,
  instanceId: string,
  auth: AntigravityAuthConfig,
): () => void {
  const key = identityKey(stateDir, instanceId);
  const previous = publishedIdentities.get(key);
  publishedIdentities.set(key, antigravityAuthIdentity(auth));
  return () => {
    if (previous === undefined) publishedIdentities.delete(key);
    else publishedIdentities.set(key, previous);
  };
}

/**
 * An instance removed from settings: adapters still built for it refuse new work. Creating the
 * ID again publishes its new identity over this one. The returned function undoes it.
 */
export function retireAntigravityAuthIdentity(stateDir: string, instanceId: string): () => void {
  const key = identityKey(stateDir, instanceId);
  const previous = publishedIdentities.get(key);
  publishedIdentities.set(key, RETIRED_IDENTITY);
  return () => {
    if (previous === undefined) publishedIdentities.delete(key);
    else publishedIdentities.set(key, previous);
  };
}
const RETIRED_IDENTITY = "\0retired";

/** False once settings published a different method or key than this adapter was built with. */
export function isAntigravityAuthCurrent(
  stateDir: string,
  instanceId: string,
  auth: AntigravityAuthConfig,
): boolean {
  const published = publishedIdentities.get(identityKey(stateDir, instanceId));
  return published === undefined || published === antigravityAuthIdentity(auth);
}

export const ANTIGRAVITY_STALE_AUTH_MESSAGE =
  "Antigravity sign-in settings just changed. Retry in a moment.";

// ── Auth state and account revision ─────────────────────────────────────────

export interface AntigravityAuthState {
  readonly version: 1;
  /** Advances whenever the account behind the instance may have changed. Never decreases. */
  readonly revision: number;
  readonly method?: AntigravityAuthMethod;
  readonly keyFingerprint?: string;
  /** The key (or sign-in) was accepted by a connect for `method`. */
  readonly verified: boolean;
  /** OAuth only: the account fingerprint seen at the last check. */
  readonly accountFingerprint?: string;
  /** Set by a successful connect; the driver runs one model discovery and clears it. */
  readonly discoveryRequested?: boolean;
  /**
   * Identity of the catalog persisted in the provider snapshot, so a restart hydrates it only
   * for the same account revision and runtime version, and remembers whether Auto was offered.
   */
  readonly catalog?: {
    readonly revision: number;
    readonly version: string | null;
    readonly autoAdvertised: boolean;
    /** The sign-in method Auto was advertised under. */
    readonly method?: AntigravityAuthMethod;
  };
  /**
   * A runtime version whose `/usage` command spent a model turn, or whose first report F5 could
   * not recognise. F5 never runs it again on that version until limit reads are turned off and on;
   * a different runtime version is asked again.
   */
  readonly usageCommandRefused?: {
    readonly version: string;
    readonly reason: "cli-spends-turn" | "cli-unrecognized";
  };
  /** A runtime version whose `/usage` command answered with a recognised report. */
  readonly usageCommandVerifiedVersion?: string;
}

const EMPTY_STATE: AntigravityAuthState = { version: 1, revision: 0, verified: false };
export const ANTIGRAVITY_AUTH_STATE_FILE = "f5-auth-state.json";
const statePath = (profileDirectory: string) =>
  path.join(profileDirectory, ANTIGRAVITY_AUTH_STATE_FILE);
/**
 * Where a Google sign-in is stored, newest format first. The 1.5.x CLI writes
 * `antigravity-oauth-token` (F5 forces file storage, so it never uses the OS keyring); earlier
 * agents wrote `acp_token.json`. The first file that exists is the sign-in.
 */
export const ANTIGRAVITY_OAUTH_TOKEN_FILES = ["antigravity-oauth-token", "acp_token.json"] as const;
export const antigravityOAuthTokenPaths = (profileDirectory: string) =>
  ANTIGRAVITY_OAUTH_TOKEN_FILES.map((file) => path.join(profileDirectory, "antigravity-acp", file));

/** The stored sign-in's path and text, or undefined when no token file exists. */
export async function readAntigravityOAuthToken(
  profileDirectory: string,
): Promise<{ readonly file: string; readonly text: string } | undefined> {
  for (const file of antigravityOAuthTokenPaths(profileDirectory)) {
    let stat;
    try {
      stat = await fs.lstat(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    if (!stat.isFile() || stat.size === 0 || stat.size > 1024 * 1024) return undefined;
    return { file, text: await fs.readFile(file, "utf8") };
  }
  return undefined;
}

function decodeCatalog(value: unknown): Pick<AntigravityAuthState, "catalog"> {
  if (value === null || typeof value !== "object") return {};
  const fields = value as Record<string, unknown>;
  if (typeof fields.revision !== "number" || !Number.isSafeInteger(fields.revision)) return {};
  const method = ANTIGRAVITY_AUTH_METHODS.find((entry) => entry.value === fields.method)?.value;
  return {
    catalog: {
      revision: fields.revision,
      version: typeof fields.version === "string" ? fields.version : null,
      autoAdvertised: fields.autoAdvertised === true,
      ...(method ? { method } : {}),
    },
  };
}

function decodeUsageRefusal(value: unknown): Pick<AntigravityAuthState, "usageCommandRefused"> {
  if (value === null || typeof value !== "object") return {};
  const { version, reason } = value as Record<string, unknown>;
  if (typeof version !== "string" || version.length === 0) return {};
  if (reason !== "cli-spends-turn" && reason !== "cli-unrecognized") return {};
  return { usageCommandRefused: { version, reason } };
}

class AntigravityAuthStateUnreadableError extends Error {
  constructor(cause: unknown) {
    super("Antigravity account state could not be read. Check the instance profile folder.", {
      cause,
    });
  }
}

function decodeState(text: string): AntigravityAuthState {
  return decodeStateOrUndefined(text, { strict: false }) ?? EMPTY_STATE;
}

const isRevision = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/**
 * `strict` (reads for a write) refuses a state whose revision is missing or not a non-negative
 * integer, so a damaged file can't restart the revision at zero.
 */
function decodeStateOrUndefined(
  text: string,
  options: { readonly strict: boolean },
): AntigravityAuthState | undefined {
  try {
    const value: unknown = JSON.parse(text);
    if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
    const fields = value as Record<string, unknown>;
    if (options.strict && !isRevision(fields.revision)) return undefined;
    const method = ANTIGRAVITY_AUTH_METHODS.find((entry) => entry.value === fields.method)?.value;
    return {
      version: 1,
      revision: isRevision(fields.revision) ? fields.revision : 0,
      ...(method ? { method } : {}),
      ...(typeof fields.keyFingerprint === "string"
        ? { keyFingerprint: fields.keyFingerprint }
        : {}),
      verified: fields.verified === true,
      ...(typeof fields.accountFingerprint === "string"
        ? { accountFingerprint: fields.accountFingerprint }
        : {}),
      ...(fields.discoveryRequested === true ? { discoveryRequested: true } : {}),
      ...decodeCatalog(fields.catalog),
      ...decodeUsageRefusal(fields.usageCommandRefused),
      ...(typeof fields.usageCommandVerifiedVersion === "string" &&
      fields.usageCommandVerifiedVersion.length > 0
        ? { usageCommandVerifiedVersion: fields.usageCommandVerifiedVersion }
        : {}),
    };
  } catch {
    return undefined;
  }
}

/** Status reads fall back to an unready state; they never write. */
export async function readAntigravityAuthState(
  profileDirectory: string,
): Promise<AntigravityAuthState> {
  try {
    return decodeState(await fs.readFile(statePath(profileDirectory), "utf8"));
  } catch {
    return EMPTY_STATE;
  }
}

/**
 * Reads for a write. Only a missing file is a new profile: an unreadable or invalid file stops
 * the write, so a revision is never reset to zero and reused.
 */
async function readAntigravityAuthStateForUpdate(
  profileDirectory: string,
): Promise<AntigravityAuthState> {
  let text: string;
  try {
    text = await fs.readFile(statePath(profileDirectory), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return EMPTY_STATE;
    throw new AntigravityAuthStateUnreadableError(error);
  }
  const state = decodeStateOrUndefined(text, { strict: true });
  if (!state) throw new AntigravityAuthStateUnreadableError(undefined);
  return state;
}

// One writer per profile in this process; account jobs and drivers share it.
const stateWrites = new Map<string, Promise<unknown>>();

export function updateAntigravityAuthState(
  profileDirectory: string,
  update: (state: AntigravityAuthState) => AntigravityAuthState,
): Promise<AntigravityAuthState> {
  const previous = stateWrites.get(profileDirectory) ?? Promise.resolve();
  const next = previous
    .catch(() => undefined)
    .then(async () => {
      const current = await readAntigravityAuthStateForUpdate(profileDirectory);
      const updated = update(current);
      // The revision is monotonic even if an updater forgets to carry it.
      const result = { ...updated, revision: Math.max(updated.revision, current.revision) };
      if (JSON.stringify(result) === JSON.stringify(current)) return current;
      await fs.mkdir(profileDirectory, { recursive: true, mode: 0o700 });
      const file = statePath(profileDirectory);
      const temporary = `${file}.${randomUUID()}.tmp`;
      try {
        await fs.writeFile(temporary, JSON.stringify(result), { mode: 0o600, flag: "wx" });
        await fs.rename(temporary, file);
      } finally {
        await fs.rm(temporary, { force: true });
      }
      return result;
    });
  stateWrites.set(profileDirectory, next);
  // Handled on both branches: the caller observes `next`'s failure, and this chain never rejects.
  const cleanup = () => {
    if (stateWrites.get(profileDirectory) === next) stateWrites.delete(profileDirectory);
  };
  next.then(cleanup, cleanup);
  return next;
}

/** Advance the revision: connect, disconnect, key or method change, or a failed transition. */
export function advanceAntigravityRevision(
  profileDirectory: string,
  /** Fields to set; an `undefined` value removes that field. */
  patch: (state: AntigravityAuthState) => {
    readonly [K in Exclude<keyof AntigravityAuthState, "version">]?:
      | AntigravityAuthState[K]
      | undefined;
  } = () => ({}),
): Promise<AntigravityAuthState> {
  return updateAntigravityAuthState(profileDirectory, (state) => {
    const merged: Record<string, unknown> = { ...state, ...patch(state) };
    for (const key of Object.keys(merged)) if (merged[key] === undefined) delete merged[key];
    return { ...(merged as unknown as AntigravityAuthState), revision: state.revision + 1 };
  });
}

/** Account identities in the state file carry this prefix; older ones are adopted, not compared. */
const ACCOUNT_IDENTITY_PREFIX = "v2:";

function idTokenSubject(idToken: string | undefined): string | undefined {
  const payload = idToken?.split(".")[1];
  if (!payload) return undefined;
  try {
    const claims: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    const sub = (claims as Record<string, unknown> | null)?.sub;
    return typeof sub === "string" && sub ? sub : undefined;
  } catch {
    return undefined;
  }
}

const identityHash = (clientId: string, subject: string) =>
  ACCOUNT_IDENTITY_PREFIX + createHash("sha256").update(`${clientId}\0${subject}`).digest("hex");

/** The client recorded for the 1.5.x CLI's token file, which stores no OAuth client of its own. */
const CLI_TOKEN_CLIENT = "antigravity-cli";

interface ParsedOAuthToken {
  /** A stable account identity, when the file has a subject that survives token refreshes. */
  readonly identity: string | undefined;
}

/**
 * Parse either token format, or undefined when the text holds no usable sign-in.
 *
 * - 1.5.x CLI (`antigravity-oauth-token`):
 *   `{ token: { access_token, refresh_token?, expiry? }, auth_method?, id_token_email? }`.
 *   The account is the `id_token_email`, else the refresh token. A file with only an access
 *   token is signed in but has no identity, since the access token rotates every hour.
 * - Earlier agents (`acp_token.json`): `{ client_id, refresh_token, id_token?, email? }`.
 */
function parseAntigravityOAuthToken(tokenText: string): ParsedOAuthToken | undefined {
  try {
    const value: unknown = JSON.parse(tokenText);
    if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
    const fields = value as Record<string, unknown>;
    const text = (entry: unknown) =>
      typeof entry === "string" && entry.trim() ? entry.trim() : undefined;
    const nested = fields.token;
    if (nested !== null && typeof nested === "object" && !Array.isArray(nested)) {
      const token = nested as Record<string, unknown>;
      const accessToken = text(token.access_token);
      const refreshToken = text(token.refresh_token);
      if (!accessToken && !refreshToken) return undefined;
      const subject = text(fields.id_token_email) ?? refreshToken;
      return { identity: subject ? identityHash(CLI_TOKEN_CLIENT, subject) : undefined };
    }
    const clientId = text(fields.client_id);
    const refreshToken = text(fields.refresh_token);
    if (!clientId || !refreshToken) return undefined;
    const subject = idTokenSubject(text(fields.id_token)) ?? text(fields.email) ?? refreshToken;
    return { identity: identityHash(clientId, subject) };
  } catch {
    return undefined;
  }
}

/**
 * The OAuth account for revision tracking. Unlike the usage identity it leaves out
 * `project_id`, which Antigravity can write after the first session, and prefers a stable
 * subject (`id_token` `sub` or `id_token_email`, then `email`) over the refresh token.
 */
export function antigravityOAuthAccountIdentity(tokenText: string): string | undefined {
  return parseAntigravityOAuthToken(tokenText)?.identity;
}

async function readOAuthToken(profileDirectory: string) {
  try {
    const stored = await readAntigravityOAuthToken(profileDirectory);
    return stored ? parseAntigravityOAuthToken(stored.text) : undefined;
  } catch {
    return undefined;
  }
}

async function readOAuthAccountFingerprint(profileDirectory: string) {
  return (await readOAuthToken(profileDirectory))?.identity;
}

/**
 * Record the configured method and key, advancing the revision when either changed since the
 * last reconciliation or the OAuth account changed on disk. The first reconciliation after an
 * upgrade only records the method, so existing threads keep resuming at revision zero.
 */
export function reconcileAntigravityAuthState(
  profileDirectory: string,
  auth: AntigravityAuthConfig,
): Promise<AntigravityAuthState> {
  return readOAuthAccountFingerprint(profileDirectory).then((accountFingerprint) =>
    updateAntigravityAuthState(profileDirectory, (state) => {
      const keyFingerprint =
        auth.authMethod === "gemini-api-key" && auth.apiKey
          ? antigravityKeyFingerprint(auth.apiKey)
          : undefined;
      const oauth = auth.authMethod === "oauth-personal";
      if (state.method === undefined)
        return {
          ...state,
          method: auth.authMethod,
          ...(keyFingerprint ? { keyFingerprint } : {}),
          ...(oauth && accountFingerprint ? { accountFingerprint } : {}),
        };
      const methodChanged = state.method !== auth.authMethod;
      const keyChanged =
        auth.authMethod === "gemini-api-key" && state.keyFingerprint !== keyFingerprint;
      // An identity recorded before the current format is adopted once, without a new revision.
      const accountChanged =
        oauth &&
        accountFingerprint !== undefined &&
        state.accountFingerprint?.startsWith(ACCOUNT_IDENTITY_PREFIX) === true &&
        state.accountFingerprint !== accountFingerprint;
      const { keyFingerprint: _key, accountFingerprint: _account, ...rest } = state;
      // A momentarily unreadable token keeps the last known account, so a different account
      // appearing later is still detected. Only an explicit transition clears it.
      const knownAccount =
        oauth && !methodChanged ? (accountFingerprint ?? state.accountFingerprint) : undefined;
      const next: AntigravityAuthState = {
        ...rest,
        method: auth.authMethod,
        ...(keyFingerprint ? { keyFingerprint } : {}),
        ...(knownAccount ? { accountFingerprint: knownAccount } : {}),
      };
      if (methodChanged || keyChanged || accountChanged)
        return { ...next, revision: state.revision + 1, verified: false };
      return next;
    }),
  );
}

/** A token file only counts when it holds a readable OAuth credential, not merely bytes. */
/**
 * A secret-free key for the account behind a profile: the stored sign-in's identity (a hash of
 * its OAuth client and subject) when the token names one, else the last known account, else the
 * account revision. Usage history and quota signals are bound to it, so a sign-in to another
 * account on the same instance never inherits the previous account's data.
 */
export async function antigravityAccountKey(profileDirectory: string): Promise<string> {
  const identity = await readOAuthAccountFingerprint(profileDirectory).catch(() => undefined);
  if (identity) return identity;
  const state = await readAntigravityAuthState(profileDirectory);
  return state.accountFingerprint ?? `revision:${state.revision}`;
}

export async function hasAntigravityOAuthToken(profileDirectory: string): Promise<boolean> {
  return (await readOAuthToken(profileDirectory)) !== undefined;
}

export interface AntigravityReadiness {
  readonly ready: boolean;
  /** Snapshot `auth.type` and `auth.label`. */
  readonly authType: AntigravityAuthMethod;
  readonly authLabel: string;
  /** Account-panel action label when not ready. */
  readonly action: "Sign in" | "Connect" | undefined;
  readonly message: string | undefined;
}

export async function antigravityReadiness(input: {
  readonly profileDirectory: string;
  readonly auth: AntigravityAuthConfig;
  /** The stored key reference could not be read from the secret store. */
  readonly keyUnavailable?: boolean;
}): Promise<AntigravityReadiness> {
  const { auth } = input;
  const base = { authType: auth.authMethod, authLabel: antigravityAuthLabel(auth.authMethod) };
  if (!isAntigravityAuthMethodExposed(auth.authMethod))
    return {
      ...base,
      ready: false,
      action: undefined,
      message: `${base.authLabel} sign-in is not available in F5 yet. Choose Google account or Gemini API key.`,
    };
  if (auth.authMethod === "oauth-personal") {
    const ready = await hasAntigravityOAuthToken(input.profileDirectory);
    return {
      ...base,
      ready,
      action: ready ? undefined : "Sign in",
      message: ready ? undefined : "Sign in to Antigravity in Settings.",
    };
  }
  // gemini-api-key. A leftover OAuth token never makes the key method look ready.
  if (input.keyUnavailable)
    return {
      ...base,
      ready: false,
      action: undefined,
      message: "The stored Gemini API key is unavailable. Re-enter it in Settings.",
    };
  if (!auth.apiKey)
    return {
      ...base,
      ready: false,
      action: undefined,
      message: "Enter a Gemini API key in the Antigravity provider settings.",
    };
  const state = await readAntigravityAuthState(input.profileDirectory);
  const ready =
    state.verified &&
    state.method === "gemini-api-key" &&
    state.keyFingerprint === antigravityKeyFingerprint(auth.apiKey);
  return {
    ...base,
    ready,
    action: ready ? undefined : "Connect",
    message: ready ? undefined : "Connect to verify this key.",
  };
}
