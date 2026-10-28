import { Effect, FileSystem, Path, Schema } from "effect";
import { fromLenientJson } from "@t3tools/shared/schemaJson";

// Match Claude Code's auto:N parsing, including clamped endpoints and grouped integers.
export function claudeToolSearchOverride(value: string | undefined): "true" | undefined {
  if (value === undefined) return;
  if (value === "auto") return "true";
  if (!value.startsWith("auto:")) return;
  const text = value.slice(5).trim();
  let percent: number;
  if (text.length <= 32 && /^[+-]?(\d+(\.\d*)?|\.\d+)[eE][+-]?\d+$/.test(text)) {
    const number = Number(text);
    percent = Number.isInteger(number) ? number : Number.NaN;
  } else if (text.length <= 32 && /^[+-]?\d{1,3}([_,\u00A0\u202F ])\d{3}(?:\1\d{3})*$/.test(text)) {
    percent = Number.parseInt(text.replace(/[_,\u00A0\u202F ]/g, ""), 10);
  } else {
    percent = Number.parseInt(text, 10);
  }
  if (Number.isNaN(percent)) return "true";
  return percent > 0 && percent < 100 ? "true" : undefined;
}

const decodeSettings = Schema.decodeUnknownEffect(
  fromLenientJson(
    Schema.Struct({ env: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)) }),
  ),
);

/** Flag settings outrank settings-file env, which outranks the process environment. */
export const resolveClaudeToolSearchOverride = Effect.fn("resolveClaudeToolSearchOverride")(
  function* (input: {
    readonly cwd?: string | undefined;
    readonly configDirectory: string;
    readonly homeDirectory: string;
    readonly platform: NodeJS.Platform;
    readonly environment: NodeJS.ProcessEnv;
  }) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const mainCheckout = (checkout: string) =>
      fs.readFileString(path.join(checkout, ".git")).pipe(
        Effect.flatMap((pointer) => {
          const gitDir = /^gitdir:\s*(.+)$/m.exec(pointer)?.[1]?.trim();
          if (!gitDir) return Effect.succeed(checkout);
          const worktreeGitDir = path.resolve(checkout, gitDir);
          return fs.readFileString(path.join(worktreeGitDir, "commondir")).pipe(
            Effect.map((commonDir) => {
              const common = path.resolve(worktreeGitDir, commonDir.trim());
              return path.basename(common) === ".git" ? path.dirname(common) : checkout;
            }),
          );
        }),
        Effect.orElseSucceed(() => checkout),
      );
    let localDirectory = input.cwd;
    if (input.cwd && input.platform !== "win32") {
      for (let directory = path.resolve(input.cwd); ; directory = path.dirname(directory)) {
        if (
          yield* fs.exists(path.join(directory, ".git")).pipe(Effect.orElseSucceed(() => false))
        ) {
          const root = yield* mainCheckout(directory);
          localDirectory = root === input.homeDirectory ? input.cwd : root;
          break;
        }
        if (path.dirname(directory) === directory) break;
      }
    }
    const files = [
      ...(input.cwd && localDirectory
        ? [
            path.join(localDirectory, ".claude", "settings.local.json"),
            ...(localDirectory === input.cwd
              ? []
              : [path.join(input.cwd, ".claude", "settings.local.json")]),
            path.join(input.cwd, ".claude", "settings.json"),
          ]
        : []),
      path.join(input.configDirectory, "settings.json"),
    ];
    for (const file of files) {
      const value = yield* fs.readFileString(file).pipe(
        Effect.flatMap(decodeSettings),
        Effect.map((settings) => settings.env?.ENABLE_TOOL_SEARCH),
        Effect.orElseSucceed(() => undefined),
      );
      if (typeof value === "string") return claudeToolSearchOverride(value);
    }
    return claudeToolSearchOverride(input.environment.ENABLE_TOOL_SEARCH);
  },
);
