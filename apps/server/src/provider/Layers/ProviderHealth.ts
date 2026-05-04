/**
 * ProviderHealthLive - Provider health checks with short-lived caching.
 *
 * Performs provider readiness probes and keeps a short-lived in-memory
 * snapshot for `server.getConfig`.
 *
 * Uses effect's ChildProcessSpawner to run CLI probes natively.
 *
 * @module ProviderHealthLive
 */
import * as OS from "node:os";
import type {
  HarnessValidationFailureKind,
  ProviderStartOptions,
  ServerProviderAuthStatus,
  ServerProviderStatus,
  ServerProviderStatusState,
} from "@t3tools/contracts";
import { Effect, FileSystem, Layer, Option, Path, Ref, Result } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";

import { buildProviderChildProcessEnv } from "../../providerProcessEnv";
import {
  formatCodexCliUpgradeMessage,
  isCodexCliVersionSupported,
  parseCodexCliVersion,
} from "../codexCliVersion";
import { ProviderHealth, type ProviderHealthShape } from "../Services/ProviderHealth";
import {
  type ProviderCliCommandResult as CommandResult,
  runClaudeCliCommand as runClaudeCommand,
  runCodexCliCommand as runCodexCommand,
} from "../providerCli.ts";

export const DEFAULT_TIMEOUT_MS = 4_000;
export const AUTH_TIMEOUT_MS = 10_000;
const PROVIDER_HEALTH_CACHE_TTL_MS = 15_000;
const CODEX_PROVIDER = "codex" as const;
const CLAUDE_AGENT_PROVIDER = "claudeAgent" as const;

export type ProviderPreflightStatus = ServerProviderStatus & {
  readonly failureReason?: HarnessValidationFailureKind;
};

// ── Pure helpers ────────────────────────────────────────────────────

function nonEmptyTrimmed(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function parseSimpleCommandVersion(stdout: string, stderr: string): string | undefined {
  return nonEmptyTrimmed(stdout) ?? nonEmptyTrimmed(stderr);
}

function isCommandMissingCause(error: unknown, binary: string): boolean {
  const lowerMessages: Array<string> = [];
  let enoent = false;
  let spawnNotFound = false;

  if (error instanceof Error) {
    lowerMessages.push(error.message.toLowerCase());
  }

  if (error && typeof error === "object") {
    const record = error as {
      readonly reason?: unknown;
      readonly cause?: unknown;
      readonly message?: unknown;
    };

    if (typeof record.message === "string") {
      lowerMessages.push(record.message.toLowerCase());
    }

    if (record.reason && typeof record.reason === "object") {
      const reason = record.reason as {
        readonly _tag?: unknown;
        readonly module?: unknown;
        readonly method?: unknown;
        readonly syscall?: unknown;
        readonly description?: unknown;
      };
      if (
        reason._tag === "NotFound" &&
        reason.module === "ChildProcess" &&
        reason.method === "spawn"
      ) {
        spawnNotFound = true;
      }
      if (typeof reason.syscall === "string") {
        lowerMessages.push(reason.syscall.toLowerCase());
      }
      if (typeof reason.description === "string") {
        lowerMessages.push(reason.description.toLowerCase());
      }
    }

    if (record.cause && typeof record.cause === "object") {
      const cause = record.cause as {
        readonly code?: unknown;
        readonly syscall?: unknown;
        readonly message?: unknown;
      };
      if (cause.code === "ENOENT") {
        enoent = true;
      }
      if (typeof cause.syscall === "string") {
        lowerMessages.push(cause.syscall.toLowerCase());
      }
      if (typeof cause.message === "string") {
        lowerMessages.push(cause.message.toLowerCase());
      }
    }
  }

  const lower = lowerMessages.join("\n");
  const basename = binary.toLowerCase().split(/[/\\]/).pop() ?? binary.toLowerCase();
  return (
    enoent ||
    spawnNotFound ||
    (lower.includes("spawn") && lower.includes("enoent")) ||
    lower.includes("no such file or directory") ||
    lower.includes(`spawn ${binary.toLowerCase()} enoent`) ||
    lower.includes(`spawn ${basename} enoent`) ||
    lower.includes(`command not found: ${binary.toLowerCase()}`) ||
    lower.includes(`command not found: ${basename}`) ||
    lower.includes(`${binary.toLowerCase()}: command not found`) ||
    lower.includes(`${basename}: command not found`) ||
    lower.includes(`${binary.toLowerCase()} not found`) ||
    lower.includes(`${basename} not found`) ||
    lower.includes(`${binary.toLowerCase()} notfound`) ||
    lower.includes(`${basename} notfound`)
  );
}

function detailFromResult(
  result: CommandResult & { readonly timedOut?: boolean },
): string | undefined {
  if (result.timedOut) return "Timed out while running command.";
  const stderr = nonEmptyTrimmed(result.stderr);
  if (stderr) return stderr;
  const stdout = nonEmptyTrimmed(result.stdout);
  if (stdout) return stdout;
  if (result.code !== 0) {
    return `Command exited with code ${result.code}.`;
  }
  return undefined;
}

function extractAuthBoolean(value: unknown): boolean | undefined {
  if (globalThis.Array.isArray(value)) {
    for (const entry of value) {
      const nested = extractAuthBoolean(entry);
      if (nested !== undefined) return nested;
    }
    return undefined;
  }

  if (!value || typeof value !== "object") return undefined;

  const record = value as Record<string, unknown>;
  for (const key of ["authenticated", "isAuthenticated", "loggedIn", "isLoggedIn"] as const) {
    if (typeof record[key] === "boolean") return record[key];
  }
  for (const key of ["auth", "status", "session", "account"] as const) {
    const nested = extractAuthBoolean(record[key]);
    if (nested !== undefined) return nested;
  }
  return undefined;
}

export function parseAuthStatusFromOutput(result: CommandResult): {
  readonly status: ServerProviderStatusState;
  readonly authStatus: ServerProviderAuthStatus;
  readonly message?: string;
} {
  const lowerOutput = `${result.stdout}\n${result.stderr}`.toLowerCase();

  if (
    lowerOutput.includes("unknown command") ||
    lowerOutput.includes("unrecognized command") ||
    lowerOutput.includes("unexpected argument")
  ) {
    return {
      status: "warning",
      authStatus: "unknown",
      message: "Codex CLI authentication status command is unavailable in this Codex version.",
    };
  }

  if (
    lowerOutput.includes("not logged in") ||
    lowerOutput.includes("login required") ||
    lowerOutput.includes("authentication required") ||
    lowerOutput.includes("run `codex login`") ||
    lowerOutput.includes("run codex login")
  ) {
    return {
      status: "error",
      authStatus: "unauthenticated",
      message: "Codex CLI is not authenticated. Run `codex login` and try again.",
    };
  }

  const parsedAuth = (() => {
    const trimmed = result.stdout.trim();
    if (!trimmed || (!trimmed.startsWith("{") && !trimmed.startsWith("["))) {
      return { attemptedJsonParse: false as const, auth: undefined as boolean | undefined };
    }
    try {
      return {
        attemptedJsonParse: true as const,
        auth: extractAuthBoolean(JSON.parse(trimmed)),
      };
    } catch {
      return { attemptedJsonParse: false as const, auth: undefined as boolean | undefined };
    }
  })();

  if (parsedAuth.auth === true) {
    return { status: "ready", authStatus: "authenticated" };
  }
  if (parsedAuth.auth === false) {
    return {
      status: "error",
      authStatus: "unauthenticated",
      message: "Codex CLI is not authenticated. Run `codex login` and try again.",
    };
  }
  if (parsedAuth.attemptedJsonParse) {
    return {
      status: "warning",
      authStatus: "unknown",
      message:
        "Could not verify Codex authentication status from JSON output (missing auth marker).",
    };
  }
  if (result.code === 0) {
    return { status: "ready", authStatus: "authenticated" };
  }

  const detail = detailFromResult(result);
  return {
    status: "warning",
    authStatus: "unknown",
    message: detail
      ? `Could not verify Codex authentication status. ${detail}`
      : "Could not verify Codex authentication status.",
  };
}

// ── Codex CLI config detection ──────────────────────────────────────

/**
 * Providers that use OpenAI-native authentication via `codex login`.
 * When the configured `model_provider` is one of these, the `codex login
 * status` probe still runs. For any other provider value the auth probe
 * is skipped because authentication is handled externally (e.g. via
 * environment variables like `PORTKEY_API_KEY` or `AZURE_API_KEY`).
 */
const OPENAI_AUTH_PROVIDERS = new Set(["openai"]);

/**
 * Read the `model_provider` value from the Codex CLI config file.
 *
 * Looks for the file at `$CODEX_HOME/config.toml` (falls back to
 * `~/.codex/config.toml`). Uses a simple line-by-line scan rather than
 * a full TOML parser to avoid adding a dependency for a single key.
 *
 * Returns `undefined` when the file does not exist or does not set
 * `model_provider`.
 */
export const readCodexConfigModelProviderWithOverrides = (input?: { readonly homePath?: string }) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const codexEnv = buildProviderChildProcessEnv(
      process.env,
      input?.homePath ? { CODEX_HOME: input.homePath } : undefined,
    );
    const codexHome = codexEnv.CODEX_HOME || path.join(OS.homedir(), ".codex");
    const configPath = path.join(codexHome, "config.toml");

    const content = yield* fileSystem
      .readFileString(configPath)
      .pipe(Effect.orElseSucceed(() => undefined));
    if (content === undefined) {
      return undefined;
    }

    // We need to find `model_provider = "..."` at the top level of the
    // TOML file (i.e. before any `[section]` header). Lines inside
    // `[profiles.*]`, `[model_providers.*]`, etc. are ignored.
    let inTopLevel = true;
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      // Skip comments and empty lines.
      if (!trimmed || trimmed.startsWith("#")) continue;
      // Detect section headers — once we leave the top level, stop.
      if (trimmed.startsWith("[")) {
        inTopLevel = false;
        continue;
      }
      if (!inTopLevel) continue;

      const match = trimmed.match(/^model_provider\s*=\s*["']([^"']+)["']/);
      if (match) return match[1];
    }
    return undefined;
  });
export const readCodexConfigModelProvider = readCodexConfigModelProviderWithOverrides();

/**
 * Returns `true` when the Codex CLI is configured with a custom
 * (non-OpenAI) model provider, meaning `codex login` auth is not
 * required because authentication is handled through provider-specific
 * environment variables.
 */
export const hasCustomModelProviderWithOverrides = (input?: { readonly homePath?: string }) =>
  Effect.map(
    readCodexConfigModelProviderWithOverrides(input),
    (provider) => provider !== undefined && !OPENAI_AUTH_PROVIDERS.has(provider),
  );
export const hasCustomModelProvider = hasCustomModelProviderWithOverrides();

// ── Health check ────────────────────────────────────────────────────

function stripFailureReason(status: ProviderPreflightStatus): ServerProviderStatus {
  const { failureReason: _failureReason, ...rest } = status;
  return rest;
}

function readCodexProviderOptions(providerOptions?: ProviderStartOptions): {
  readonly binaryPath?: string;
  readonly envOverrides?: NodeJS.ProcessEnv;
  readonly homePath?: string;
} {
  const binaryPath = providerOptions?.codex?.binaryPath;
  const homePath = providerOptions?.codex?.homePath;
  return {
    ...(binaryPath ? { binaryPath } : {}),
    ...(homePath ? { homePath } : {}),
    ...(homePath ? { envOverrides: { CODEX_HOME: homePath } } : {}),
  };
}

function readClaudeProviderOptions(providerOptions?: ProviderStartOptions): {
  readonly binaryPath?: string;
} {
  const binaryPath = providerOptions?.claudeAgent?.binaryPath;
  return binaryPath ? { binaryPath } : {};
}

export const checkCodexProviderPreflight = (input?: {
  readonly providerOptions?: ProviderStartOptions;
}): Effect.Effect<
  ProviderPreflightStatus,
  never,
  ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
> =>
  Effect.gen(function* () {
    const checkedAt = new Date().toISOString();
    const codexOptions = readCodexProviderOptions(input?.providerOptions);
    const binaryPath = codexOptions.binaryPath ?? "codex";

    // Probe 1: `codex --version` — is the CLI reachable?
    const versionProbe = yield* runCodexCommand(["--version"], codexOptions).pipe(
      Effect.timeoutOption(DEFAULT_TIMEOUT_MS),
      Effect.result,
    );

    if (Result.isFailure(versionProbe)) {
      const error = versionProbe.failure;
      return {
        provider: CODEX_PROVIDER,
        status: "error" as const,
        available: false,
        authStatus: "unknown" as const,
        checkedAt,
        failureReason: isCommandMissingCause(error, binaryPath)
          ? "notInstalled"
          : "versionProbeFailed",
        message: isCommandMissingCause(error, binaryPath)
          ? "Codex CLI (`codex`) is not installed or not on PATH."
          : `Failed to execute Codex CLI health check: ${error instanceof Error ? error.message : String(error)}.`,
      };
    }

    if (Option.isNone(versionProbe.success)) {
      return {
        provider: CODEX_PROVIDER,
        status: "error" as const,
        available: false,
        authStatus: "unknown" as const,
        checkedAt,
        failureReason: "versionProbeTimeout",
        message: "Codex CLI is installed but failed to run. Timed out while running command.",
      };
    }

    const version = versionProbe.success.value;
    if (version.code !== 0) {
      const detail = detailFromResult(version);
      const parsedVersion = parseCodexCliVersion(`${version.stdout}\n${version.stderr}`);
      return {
        provider: CODEX_PROVIDER,
        status: "error" as const,
        available: false,
        authStatus: "unknown" as const,
        checkedAt,
        failureReason: "versionProbeFailed",
        ...(parsedVersion ? { version: parsedVersion } : {}),
        message: detail
          ? `Codex CLI is installed but failed to run. ${detail}`
          : "Codex CLI is installed but failed to run.",
      };
    }

    const parsedVersion = parseCodexCliVersion(`${version.stdout}\n${version.stderr}`);
    if (parsedVersion && !isCodexCliVersionSupported(parsedVersion)) {
      return {
        provider: CODEX_PROVIDER,
        status: "error" as const,
        available: false,
        authStatus: "unknown" as const,
        checkedAt,
        failureReason: "unsupportedVersion",
        ...(parsedVersion ? { version: parsedVersion } : {}),
        message: formatCodexCliUpgradeMessage(parsedVersion),
      };
    }

    // Probe 2: `codex login status` — is the user authenticated?
    //
    // Custom model providers (e.g. Portkey, Azure OpenAI proxy) handle
    // authentication through their own environment variables, so `codex
    // login status` will report "not logged in" even when the CLI works
    // fine. Skip the auth probe entirely for non-OpenAI providers.
    if (
      yield* hasCustomModelProviderWithOverrides(
        codexOptions.homePath ? { homePath: codexOptions.homePath } : undefined,
      )
    ) {
      return {
        provider: CODEX_PROVIDER,
        status: "ready" as const,
        available: true,
        authStatus: "unknown" as const,
        checkedAt,
        ...(parsedVersion ? { version: parsedVersion } : {}),
        message: "Using a custom Codex model provider; OpenAI login check skipped.",
      } satisfies ProviderPreflightStatus;
    }

    const authProbe = yield* runCodexCommand(["login", "status"], codexOptions).pipe(
      Effect.timeoutOption(DEFAULT_TIMEOUT_MS),
      Effect.result,
    );

    if (Result.isFailure(authProbe)) {
      const error = authProbe.failure;
      return {
        provider: CODEX_PROVIDER,
        status: "warning" as const,
        available: true,
        authStatus: "unknown" as const,
        checkedAt,
        ...(parsedVersion ? { version: parsedVersion } : {}),
        message:
          error instanceof Error
            ? `Could not verify Codex authentication status: ${error.message}.`
            : "Could not verify Codex authentication status.",
      };
    }

    if (Option.isNone(authProbe.success)) {
      return {
        provider: CODEX_PROVIDER,
        status: "warning" as const,
        available: true,
        authStatus: "unknown" as const,
        checkedAt,
        ...(parsedVersion ? { version: parsedVersion } : {}),
        message: "Could not verify Codex authentication status. Timed out while running command.",
      };
    }

    const parsed = parseAuthStatusFromOutput(authProbe.success.value);
    return {
      provider: CODEX_PROVIDER,
      status: parsed.status,
      available: true,
      authStatus: parsed.authStatus,
      checkedAt,
      ...(parsed.authStatus === "unauthenticated" ? { failureReason: "unauthenticated" } : {}),
      ...(parsedVersion ? { version: parsedVersion } : {}),
      ...(parsed.message ? { message: parsed.message } : {}),
    } satisfies ProviderPreflightStatus;
  });

export const checkClaudeProviderPreflight = (input?: {
  readonly providerOptions?: ProviderStartOptions;
}): Effect.Effect<ProviderPreflightStatus, never, ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function* () {
    const checkedAt = new Date().toISOString();
    const claudeOptions = readClaudeProviderOptions(input?.providerOptions);
    const binaryPath = claudeOptions.binaryPath ?? "claude";

    // Probe 1: `claude --version` — is the CLI reachable?
    const versionProbe = yield* runClaudeCommand(["--version"], claudeOptions).pipe(
      Effect.timeoutOption(DEFAULT_TIMEOUT_MS),
      Effect.result,
    );

    if (Result.isFailure(versionProbe)) {
      const error = versionProbe.failure;
      return {
        provider: CLAUDE_AGENT_PROVIDER,
        status: "error" as const,
        available: false,
        authStatus: "unknown" as const,
        checkedAt,
        failureReason: isCommandMissingCause(error, binaryPath)
          ? "notInstalled"
          : "versionProbeFailed",
        message: isCommandMissingCause(error, binaryPath)
          ? "Claude Agent CLI (`claude`) is not installed or not on PATH."
          : `Failed to execute Claude Agent CLI health check: ${error instanceof Error ? error.message : String(error)}.`,
      };
    }

    if (Option.isNone(versionProbe.success)) {
      return {
        provider: CLAUDE_AGENT_PROVIDER,
        status: "error" as const,
        available: false,
        authStatus: "unknown" as const,
        checkedAt,
        failureReason: "versionProbeTimeout",
        message:
          "Claude Agent CLI is installed but failed to run. Timed out while running command.",
      };
    }

    const version = versionProbe.success.value;
    const parsedVersion = parseSimpleCommandVersion(version.stdout, version.stderr);
    if (version.code !== 0) {
      const detail = detailFromResult(version);
      return {
        provider: CLAUDE_AGENT_PROVIDER,
        status: "error" as const,
        available: false,
        authStatus: "unknown" as const,
        checkedAt,
        failureReason: "versionProbeFailed",
        ...(parsedVersion ? { version: parsedVersion } : {}),
        message: detail
          ? `Claude Agent CLI is installed but failed to run. ${detail}`
          : "Claude Agent CLI is installed but failed to run.",
      };
    }

    // Probe 2: `claude auth status` — is the user authenticated?
    const authProbe = yield* runClaudeCommand(["auth", "status"], claudeOptions).pipe(
      Effect.timeoutOption(AUTH_TIMEOUT_MS),
      Effect.result,
    );

    if (Result.isFailure(authProbe)) {
      const error = authProbe.failure;
      return {
        provider: CLAUDE_AGENT_PROVIDER,
        status: "ready" as const,
        available: true,
        authStatus: "unknown" as const,
        checkedAt,
        ...(parsedVersion ? { version: parsedVersion } : {}),
        message:
          error instanceof Error
            ? `Could not verify Claude authentication status: ${error.message}.`
            : "Could not verify Claude authentication status.",
      };
    }

    if (Option.isNone(authProbe.success)) {
      return {
        provider: CLAUDE_AGENT_PROVIDER,
        status: "ready" as const,
        available: true,
        authStatus: "unknown" as const,
        checkedAt,
        ...(parsedVersion ? { version: parsedVersion } : {}),
        message: "Could not verify Claude authentication status. Timed out while running command.",
      };
    }

    const parsed = parseClaudeAuthStatusFromOutput(authProbe.success.value);
    return {
      provider: CLAUDE_AGENT_PROVIDER,
      status: parsed.status,
      available: true,
      authStatus: parsed.authStatus,
      checkedAt,
      ...(parsed.authStatus === "unauthenticated" ? { failureReason: "unauthenticated" } : {}),
      ...(parsedVersion ? { version: parsedVersion } : {}),
      ...(parsed.message ? { message: parsed.message } : {}),
    } satisfies ProviderPreflightStatus;
  });

export const checkCodexProviderStatus: Effect.Effect<
  ServerProviderStatus,
  never,
  ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
> = checkCodexProviderPreflight().pipe(Effect.map(stripFailureReason));

// ── Claude Agent health check ───────────────────────────────────────

export function parseClaudeAuthStatusFromOutput(result: CommandResult): {
  readonly status: ServerProviderStatusState;
  readonly authStatus: ServerProviderAuthStatus;
  readonly message?: string;
} {
  const lowerOutput = `${result.stdout}\n${result.stderr}`.toLowerCase();

  if (
    lowerOutput.includes("unknown command") ||
    lowerOutput.includes("unrecognized command") ||
    lowerOutput.includes("unexpected argument")
  ) {
    return {
      status: "ready",
      authStatus: "unknown",
      message:
        "Claude Agent authentication status command is unavailable in this version of Claude.",
    };
  }

  if (
    lowerOutput.includes("not logged in") ||
    lowerOutput.includes("login required") ||
    lowerOutput.includes("authentication required") ||
    lowerOutput.includes("run `claude login`") ||
    lowerOutput.includes("run claude login")
  ) {
    return {
      status: "error",
      authStatus: "unauthenticated",
      message: "Claude is not authenticated. Run `claude auth login` and try again.",
    };
  }

  // `claude auth status` returns JSON with a `loggedIn` boolean.
  const parsedAuth = (() => {
    const trimmed = result.stdout.trim();
    if (!trimmed || (!trimmed.startsWith("{") && !trimmed.startsWith("["))) {
      return { attemptedJsonParse: false as const, auth: undefined as boolean | undefined };
    }
    try {
      return {
        attemptedJsonParse: true as const,
        auth: extractAuthBoolean(JSON.parse(trimmed)),
      };
    } catch {
      return { attemptedJsonParse: false as const, auth: undefined as boolean | undefined };
    }
  })();

  if (parsedAuth.auth === true) {
    return { status: "ready", authStatus: "authenticated" };
  }
  if (parsedAuth.auth === false) {
    return {
      status: "error",
      authStatus: "unauthenticated",
      message: "Claude is not authenticated. Run `claude auth login` and try again.",
    };
  }
  if (parsedAuth.attemptedJsonParse) {
    return {
      status: "ready",
      authStatus: "unknown",
      message:
        "Could not verify Claude authentication status from JSON output (missing auth marker).",
    };
  }
  if (result.code === 0) {
    return { status: "ready", authStatus: "authenticated" };
  }

  const detail = detailFromResult(result);
  return {
    status: "ready",
    authStatus: "unknown",
    message: detail
      ? `Could not verify Claude authentication status. ${detail}`
      : "Could not verify Claude authentication status.",
  };
}

export const checkClaudeProviderStatus: Effect.Effect<
  ServerProviderStatus,
  never,
  ChildProcessSpawner.ChildProcessSpawner
> = checkClaudeProviderPreflight().pipe(Effect.map(stripFailureReason));

// ── Layer ───────────────────────────────────────────────────────────

export const ProviderHealthLive = Layer.effect(
  ProviderHealth,
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const statusCache = yield* Effect.sync(() => ({
      value: null as ReadonlyArray<ServerProviderStatus> | null,
      checkedAtMs: 0,
    })).pipe(Effect.flatMap(Ref.make));

    const computeStatuses = Effect.all(
      [
        checkCodexProviderStatus.pipe(
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(Path.Path, path),
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, childProcessSpawner),
        ),
        checkClaudeProviderStatus.pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, childProcessSpawner),
        ),
      ],
      { concurrency: 2 },
    );

    return {
      getStatuses: Ref.get(statusCache).pipe(
        Effect.flatMap((cached) => {
          const now = Date.now();
          if (cached.value !== null && now - cached.checkedAtMs < PROVIDER_HEALTH_CACHE_TTL_MS) {
            return Effect.succeed(cached.value);
          }

          return computeStatuses.pipe(
            Effect.tap((statuses) =>
              Ref.set(statusCache, {
                value: statuses,
                checkedAtMs: now,
              }),
            ),
          );
        }),
      ),
    } satisfies ProviderHealthShape;
  }),
);
