import { realpath } from "node:fs/promises";
import { Effect } from "effect";
import {
  CommandNotFoundError,
  resolveExecutable,
  resolveInvocationEffect,
  type ResolvedCliInvocation,
} from "../../spawn/resolveCommand.ts";

/** Muse requires the true-case canonical Windows root, including the verbatim prefix. */
export async function museWorkspaceRoot(cwd: string, platform = process.platform): Promise<string> {
  if (platform !== "win32") return cwd;
  const canonical = await realpath(cwd).catch(() => cwd.replaceAll("/", "\\"));
  if (canonical.startsWith("\\\\?\\")) return canonical;
  return canonical.startsWith("\\\\") ? "\\\\?\\UNC\\" + canonical.slice(2) : "\\\\?\\" + canonical;
}

/** Muse's native installer uses a cmd launcher rather than a standard npm shim. */
export const resolveMuseInvocation = (
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  cwd: string,
  platform: NodeJS.Platform = process.platform,
): Effect.Effect<ResolvedCliInvocation, CommandNotFoundError> =>
  resolveInvocationEffect(command, args, env, { cwd, platform }).pipe(
    Effect.catch((error) =>
      Effect.try({
        try: () => {
          const executable =
            platform === "win32" ? resolveExecutable(command, env, { cwd, platform }) : null;
          if (!executable || !/\.(cmd|bat)$/i.test(executable)) throw error;
          const value = (name: string) =>
            env[Object.keys(env).find((key) => key.toLowerCase() === name.toLowerCase()) ?? name];
          const shell =
            value("ComSpec") ??
            (value("SystemRoot") ? value("SystemRoot") + "\\System32\\cmd.exe" : "cmd.exe");
          return {
            file: shell,
            args: [
              "/d",
              "/c",
              ...(/\s/.test(executable)
                ? ["@", executable]
                : [executable.replace(/[()&<>@^|]/g, "^$&")]),
              ...args,
            ],
            kind: "native" as const,
          };
        },
        catch: (cause) =>
          cause instanceof CommandNotFoundError
            ? cause
            : new CommandNotFoundError(command, String(cause)),
      }),
    ),
  );
