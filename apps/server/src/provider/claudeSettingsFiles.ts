import { Effect, FileSystem, Path } from "effect";

export const claudeSettingsFilesByPrecedence = Effect.fn("claudeSettingsFilesByPrecedence")(
  function* (input: {
    readonly cwd?: string | undefined;
    readonly configDirectory: string;
    readonly homeDirectory: string;
    readonly platform: NodeJS.Platform;
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
    return [
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
  },
);
