/**
 * Parse a user-supplied Claude CLI launch-argument string into the
 * `Record<string, string | null>` shape expected by
 * `@anthropic-ai/claude-agent-sdk`'s `extraArgs` option.
 *
 * Supported forms:
 *  - `--flag`            → `{ flag: null }`
 *  - `--key=value`       → `{ key: "value" }`
 *  - `--key value`       → `{ key: "value" }`
 *  - Quoted values: `--key="some value"` or `--key "some value"`
 *
 * Positional tokens (anything not starting with `--`) are rejected.
 * Duplicate keys keep the last-wins value, consistent with argv merging.
 *
 * The parser is intentionally conservative: it only understands the subset
 * the SDK's `extraArgs` surface handles. We don't try to reproduce full
 * shell quoting — single/double-quoted values are unwrapped but shell
 * escapes inside quotes are not interpreted.
 *
 * @module cliArgs
 */

export interface ClaudeLaunchArgsParseSuccess {
  readonly ok: true;
  readonly args: Record<string, string | null>;
}

export interface ClaudeLaunchArgsParseFailure {
  readonly ok: false;
  readonly error: string;
}

export type ClaudeLaunchArgsParseResult =
  | ClaudeLaunchArgsParseSuccess
  | ClaudeLaunchArgsParseFailure;

export interface LaunchArgvParseSuccess {
  readonly ok: true;
  readonly argv: ReadonlyArray<string>;
}

export interface LaunchArgvParseFailure {
  readonly ok: false;
  readonly error: string;
}

export type LaunchArgvParseResult = LaunchArgvParseSuccess | LaunchArgvParseFailure;

export const MAX_LAUNCH_ARGS_CHARS = 32 * 1024;
export const MAX_LAUNCH_ARG_TOKENS = 256;

const FLAG_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9-]*$/;

/**
 * Flags the SDK / adapter already drives from first-class settings or that
 * govern security, session identity, or transport. Forwarding user overrides
 * for any of these via `extraArgs` can silently break the protocol
 * (output/input format), attach the runtime to the wrong session, or bypass
 * approval gates. The denylist is enforced both at parse time (so the UI
 * surfaces a clear error) and again by the adapter (see
 * `filterReservedClaudeLaunchArgs`) as a belt-and-suspenders check in case
 * an older persisted value slips through.
 */
const RESERVED_FLAG_NAMES: ReadonlySet<string> = new Set([
  "output-format",
  "input-format",
  "permission-mode",
  "allow-dangerously-skip-permissions",
  "dangerously-skip-permissions",
  "session-id",
  "resume",
  "continue",
  "mcp-config",
  "add-dir",
  "append-system-prompt",
  "system-prompt",
  "settings",
  "setting-sources",
  "allowed-tools",
  "allowedTools",
  "disallowed-tools",
  "disallowedTools",
  "permission-prompt-tool",
  "cwd",
  "print",
]);

export function isReservedClaudeLaunchArgName(name: string): boolean {
  return RESERVED_FLAG_NAMES.has(name);
}

/**
 * Drop any entries whose keys are reserved by the adapter or SDK. Callers
 * that forward launch args straight to the Claude SDK's `extraArgs` option
 * should run their input through this filter so stale persisted values or
 * pre-denylist settings can't smuggle reserved flags through.
 */
export function filterReservedClaudeLaunchArgs(
  args: Record<string, string | null> | undefined | null,
): Record<string, string | null> | undefined {
  if (!args) return undefined;
  const out: Record<string, string | null> = {};
  for (const [key, value] of Object.entries(args)) {
    if (isReservedClaudeLaunchArgName(key)) continue;
    out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function stripSurroundingQuotes(value: string): string {
  if (value.length < 2) return value;
  const first = value[0];
  const last = value[value.length - 1];
  if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
    return value.slice(1, -1);
  }
  return value;
}

/**
 * Tokenize a user-provided launch-args string into argv-style tokens without
 * invoking a shell. This intentionally performs no variable, command, or glob
 * expansion. Backslashes escape the next character outside single quotes and
 * the conventional quote/backslash characters inside double quotes.
 */
export function parseLaunchArgv(input: string | null | undefined): LaunchArgvParseResult {
  const raw = input ?? "";
  if (raw.includes("\0")) {
    return { ok: false, error: "Launch arguments cannot contain NUL bytes." };
  }
  if (raw.length > MAX_LAUNCH_ARGS_CHARS) {
    return {
      ok: false,
      error: `Launch arguments exceed the ${MAX_LAUNCH_ARGS_CHARS}-character limit.`,
    };
  }

  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let inToken = false;

  const pushToken = (): LaunchArgvParseFailure | undefined => {
    tokens.push(current);
    current = "";
    inToken = false;
    if (tokens.length > MAX_LAUNCH_ARG_TOKENS) {
      return {
        ok: false,
        error: `Launch arguments exceed the ${MAX_LAUNCH_ARG_TOKENS}-token limit.`,
      };
    }
    return undefined;
  };

  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index]!;
    if (quote) {
      if (char === quote) {
        quote = null;
        inToken = true;
        continue;
      }
      if (char === "\\" && quote === '"') {
        const next = raw[index + 1];
        if (next !== undefined && ['"', "\\", "$", "`"].includes(next)) {
          current += next;
          index += 1;
          inToken = true;
          continue;
        }
      }
      current += char;
      inToken = true;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      inToken = true;
      continue;
    }
    if (char === " " || char === "\t" || char === "\n" || char === "\r") {
      if (inToken) {
        const failure = pushToken();
        if (failure) return failure;
      }
      continue;
    }
    if (char === "\\") {
      const next = raw[index + 1];
      if (next === undefined) {
        return { ok: false, error: "Launch arguments cannot end with an escape character." };
      }
      current += next;
      index += 1;
      inToken = true;
      continue;
    }
    current += char;
    inToken = true;
  }

  if (quote) {
    return { ok: false, error: `Unterminated ${quote === '"' ? "double" : "single"} quote.` };
  }
  if (inToken) {
    const failure = pushToken();
    if (failure) return failure;
  }

  return { ok: true, argv: tokens };
}

/**
 * Parse a string of additional CLI arguments that should be forwarded to
 * the Claude Code CLI via the SDK's `extraArgs` option. Returns a result
 * object so callers can surface validation errors directly in the UI.
 */
export function parseClaudeLaunchArgs(
  input: string | null | undefined,
): ClaudeLaunchArgsParseResult {
  const trimmed = (input ?? "").trim();
  if (trimmed.length === 0) {
    return { ok: true, args: {} };
  }

  const parsedArgv = parseLaunchArgv(trimmed);
  if (!parsedArgv.ok) {
    return parsedArgv;
  }
  const tokens = parsedArgv.argv;
  const args: Record<string, string | null> = {};

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (!token.startsWith("--")) {
      return {
        ok: false,
        error: `Unexpected positional token "${token}". Every argument must start with "--".`,
      };
    }

    const body = token.slice(2);
    if (body.length === 0) {
      return { ok: false, error: `Empty flag name at token ${index + 1}.` };
    }

    const equalsIndex = body.indexOf("=");
    if (equalsIndex >= 0) {
      const name = body.slice(0, equalsIndex);
      const value = stripSurroundingQuotes(body.slice(equalsIndex + 1));
      if (!FLAG_NAME_PATTERN.test(name)) {
        return { ok: false, error: `Invalid flag name "--${name}".` };
      }
      if (isReservedClaudeLaunchArgName(name)) {
        return {
          ok: false,
          error: `"--${name}" is managed by the app and cannot be overridden here.`,
        };
      }
      args[name] = value;
      continue;
    }

    const name = body;
    if (!FLAG_NAME_PATTERN.test(name)) {
      return { ok: false, error: `Invalid flag name "--${name}".` };
    }
    if (isReservedClaudeLaunchArgName(name)) {
      return {
        ok: false,
        error: `"--${name}" is managed by the app and cannot be overridden here.`,
      };
    }

    const peek = tokens[index + 1];
    if (peek !== undefined && !peek.startsWith("--")) {
      args[name] = peek;
      index += 1;
      continue;
    }

    args[name] = null;
  }

  return { ok: true, args };
}

/**
 * Normalize a launch-args record into a stable, sorted form so semantic
 * comparisons (`areProviderStartOptionsEqual`) don't treat key ordering
 * as a meaningful difference.
 */
export function canonicalizeClaudeLaunchArgs(
  args: Record<string, string | null> | undefined | null,
): Record<string, string | null> | undefined {
  if (!args) return undefined;
  const keys = Object.keys(args).toSorted();
  if (keys.length === 0) return undefined;
  const out: Record<string, string | null> = {};
  for (const key of keys) {
    const value = args[key];
    if (value === undefined) continue;
    if (!FLAG_NAME_PATTERN.test(key)) continue;
    if (isReservedClaudeLaunchArgName(key)) continue;
    out[key] = value === null ? null : String(value);
  }
  return Object.keys(out).length > 0 ? out : undefined;
}
