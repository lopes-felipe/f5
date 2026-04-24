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
 * Tokenize a user-provided launch-args string into argv-style tokens,
 * honoring single and double quotes so values containing spaces survive
 * whole. Backslash escapes are treated as literal backslashes — users
 * should rely on quoting for values with spaces.
 */
function tokenize(raw: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let inToken = false;

  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index]!;
    if (quote) {
      if (char === quote) {
        quote = null;
        continue;
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
        tokens.push(current);
        current = "";
        inToken = false;
      }
      continue;
    }
    current += char;
    inToken = true;
  }

  if (inToken) {
    tokens.push(current);
  }

  return tokens;
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

  const tokens = tokenize(trimmed);
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
